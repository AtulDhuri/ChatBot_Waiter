"""DineOS end-to-end test + narrated demo recording.

Drives the REAL app with separate, real logins for every role (admin, kitchen,
manager) plus two guest phones, asserts each feature works, and records one
1080p video in which all screens are composited live on a "stage" page.

How the video is built: every role runs in its own browser context. A CDP
screencast streams each one into a stage page (canvas panes + captions), and
a second screencast of the stage is encoded to WebM with Playwright's bundled
ffmpeg. No full ffmpeg install is needed.

Usage (server must be running, e.g. uvicorn on 127.0.0.1:8000):

    $env:DINEOS_ADMIN_USER="..."; $env:DINEOS_ADMIN_PASS="..."
    $env:DINEOS_KITCHEN_USER="..."; $env:DINEOS_KITCHEN_PASS="..."
    $env:DINEOS_MANAGER_USER="..."; $env:DINEOS_MANAGER_PASS="..."
    python scripts/e2e_demo.py

Optional env: DINEOS_BASE (default http://127.0.0.1:8000), DINEOS_SLUG
(default anita), DINEOS_TABLE (default T1), DINEOS_QR_LIBS (folder holding the
zxing-cpp + pillow wheels used to decode QR codes; QR decode checks are skipped
if unavailable).

Outputs (demo-recording/): dineos-e2e-demo.webm, e2e-test-report.md,
e2e-results.json, e2e-*.png stills, and e2e-failures/ screenshots on failure.

Side effects on the target restaurant: places 3 real orders (2 dine-in rounds
+ 1 takeaway), cancels one item, settles them as paid, and briefly marks one
dish sold out (restored afterwards). Nothing else is modified.
"""
import asyncio
import base64
import glob
import io
import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import date, datetime

from playwright.async_api import async_playwright, expect

# ── Config ──────────────────────────────────────────────────────────────────
BASE = os.environ.get("DINEOS_BASE", "http://127.0.0.1:8000").rstrip("/")
SLUG = os.environ.get("DINEOS_SLUG", "anita")
TABLE = os.environ.get("DINEOS_TABLE", "T1")


def _cred(role):
    u = os.environ.get("DINEOS_%s_USER" % role)
    p = os.environ.get("DINEOS_%s_PASS" % role)
    if not u or not p:
        sys.exit("Missing DINEOS_%s_USER / DINEOS_%s_PASS env vars." % (role, role))
    return u, p


ADMIN = _cred("ADMIN")
KITCHEN = _cred("KITCHEN")
MANAGER = _cred("MANAGER")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "demo-recording")
FAIL_DIR = os.path.join(OUT, "e2e-failures")
# DINEOS_MODE=owner records a short sales demo for restaurant owners: logins
# happen off camera, captions talk about benefits, the test counter is hidden
# and only the core story is shown. Checks still run and are reported.
OWNER = os.environ.get("DINEOS_MODE", "").lower() == "owner"
SUFFIX = "-owner" if OWNER else ""
VIDEO = os.path.join(OUT, "dineos-owner-demo.webm" if OWNER else "dineos-e2e-demo.webm")
os.makedirs(OUT, exist_ok=True)

QR_LIBS = os.environ.get("DINEOS_QR_LIBS", os.path.join(os.environ.get("TEMP", ""), "qrdec"))
if QR_LIBS and os.path.isdir(QR_LIBS):
    sys.path.insert(0, QR_LIBS)
try:
    import zxingcpp  # type: ignore
    from PIL import Image  # type: ignore

    HAVE_QR = True
except Exception:  # pragma: no cover - optional dependency
    HAVE_QR = False


def find_ffmpeg():
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright")
    for d in sorted(glob.glob(os.path.join(root, "ffmpeg-*")), reverse=True):
        exe = os.path.join(d, "ffmpeg-win64.exe")
        if not os.path.exists(exe):
            continue
        r = subprocess.run([exe, "-hide_banner", "-h", "encoder=libvpx"], capture_output=True, text=True)
        if "VP8" in (r.stdout + r.stderr) and "is not recognized" not in (r.stdout + r.stderr):
            return exe
    return None


FFMPEG = find_ffmpeg()

LOGO = os.environ.get("DINEOS_LOGO", os.path.join(ROOT, "demo-recording", "Dineos01.jpeg"))


def logo_data_url():
    """Brand logo as a data URL, trimmed when Pillow is available.

    Transparent PNGs are cropped to their visible pixels. Opaque logos (e.g. a
    white wordmark on a coloured background) keep their background and are
    cropped to the wordmark plus an even margin, so they read as a badge.
    """
    if not LOGO or not os.path.exists(LOGO):
        return None
    mime = "image/jpeg" if LOGO.lower().endswith((".jpg", ".jpeg")) else "image/png"
    try:
        from PIL import Image as _Img  # type: ignore
        im = _Img.open(LOGO)
        if im.mode in ("RGBA", "LA") and im.split()[-1].getextrema()[0] < 255:
            im = im.convert("RGBA")
            bbox = im.split()[3].getbbox()
        else:
            im = im.convert("RGB")
            # Some exports carry a thin light frame on the edge; drop 1.5%
            # per side so it isn't mistaken for the wordmark.
            ix, iy = round(im.width * 0.015), round(im.height * 0.015)
            im = im.crop((ix, iy, im.width - ix, im.height - iy))
            # Bright pixels = the wordmark; crop to them with padding.
            mask = im.convert("L").point(lambda v: 255 if v > 200 else 0)
            bbox = mask.getbbox()
            if bbox:
                pad = round((bbox[3] - bbox[1]) * 0.12)
                bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                        min(im.width, bbox[2] + pad), min(im.height, bbox[3] + pad))
        if bbox:
            im = im.crop(bbox)
        if im.height > 300:
            im = im.resize((round(im.width * 300 / im.height), 300), _Img.LANCZOS)
        buf = io.BytesIO()
        if im.mode == "RGBA":
            im.save(buf, "PNG")
            mime = "image/png"
        else:
            im.save(buf, "PNG")
            mime = "image/png"
        data = buf.getvalue()
    except Exception:
        with open(LOGO, "rb") as f:
            data = f.read()
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))

PHONE = {"width": 390, "height": 844}
DESK = {"width": 1280, "height": 720}

# ── Stage page (compositor) ─────────────────────────────────────────────────
STAGE_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><style>
:root{--gold:#d9b779;--muted:#8b929e}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1920px;height:1080px;overflow:hidden;color:#f5f3ee;
 font-family:Inter,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased;
 background:radial-gradient(1100px 650px at 12% -10%,#2a2216 0%,rgba(10,11,13,0) 60%),
            radial-gradient(900px 600px at 100% 110%,#13202a 0%,rgba(10,11,13,0) 60%),#0a0b0d}
#top{position:absolute;left:0;right:0;top:0;height:58px;display:flex;align-items:center;
 justify-content:space-between;padding:0 40px;z-index:5}
.brand{display:flex;align-items:center;font-weight:800;font-size:21px;letter-spacing:-.3px}
.brand b{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:9px 9px 9px 3px;
 background:var(--gold);color:#17120a;margin-right:11px;font-size:17px;font-family:Georgia,serif}
#chapter{font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);font-weight:700}
#checks{font-size:14px;font-weight:700;padding:7px 15px;border-radius:999px;color:#9be6bc;
 background:rgba(98,212,154,.08);border:1px solid rgba(98,212,154,.3);font-variant-numeric:tabular-nums}
#checks.bad{color:#f3a19a;background:rgba(229,130,122,.1);border-color:rgba(229,130,122,.4)}
.pane{position:absolute;opacity:0;transform:translateY(18px) scale(.975);pointer-events:none;
 transition:left .8s cubic-bezier(.2,.8,.2,1),top .8s cubic-bezier(.2,.8,.2,1),width .8s cubic-bezier(.2,.8,.2,1),
 opacity .6s,transform .8s cubic-bezier(.2,.8,.2,1)}
.pane.on{opacity:1;transform:none}
.pane canvas{display:block;width:100%;height:auto;background:#0a0b0d}
.desk{background:#16191e;border:1px solid rgba(255,255,255,.1);border-radius:14px;overflow:hidden;
 box-shadow:0 40px 90px rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.4)}
.bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1c2027;
 border-bottom:1px solid rgba(255,255,255,.06)}
.dot{width:11px;height:11px;border-radius:50%}
.who{margin-left:10px;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);white-space:nowrap}
.url{margin-left:8px;flex:1;height:22px;border-radius:7px;background:#0f1216;color:var(--muted);font-size:12px;
 display:flex;align-items:center;padding:0 10px;white-space:nowrap;overflow:hidden}
.phone{padding:12px;border-radius:54px;background:linear-gradient(150deg,#30343b,#121418 60%);
 box-shadow:0 0 0 2px #3c4048,0 40px 90px rgba(0,0,0,.75)}
.phone canvas{border-radius:42px}
.phone .who{position:absolute;left:0;right:0;bottom:-30px;text-align:center;margin:0}
#cap{position:absolute;z-index:6;transition:left .8s cubic-bezier(.2,.8,.2,1),top .8s cubic-bezier(.2,.8,.2,1),width .8s,opacity .35s}
#cap.fade{opacity:0}
#cap .k{display:inline-block;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);font-weight:800;margin-bottom:12px}
#cap h2{font-size:36px;font-weight:760;letter-spacing:-.6px;line-height:1.14}
#cap p{margin-top:12px;font-size:20px;color:#c4c8cf;line-height:1.5}
#cap.lower h2{font-size:30px}#cap.lower p{font-size:18px;margin-top:8px}
#cap.lower{display:flex;gap:28px;align-items:baseline}
#cap.lower .k{margin:0;white-space:nowrap}
#list{position:absolute;z-index:6;display:flex;flex-direction:column;gap:9px;opacity:0;transition:opacity .5s,left .8s,top .8s}
#list.on{opacity:1}
#list .it{display:flex;gap:10px;align-items:flex-start;font-size:15.5px;line-height:1.35;color:#c4c8cf;
 animation:in .45s cubic-bezier(.2,.8,.2,1)}
#list .ic{flex:0 0 22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:900;
 background:rgba(98,212,154,.15);color:#7ee0aa;border:1px solid rgba(98,212,154,.35)}
#list .it.bad .ic{background:rgba(229,130,122,.15);color:#f3a19a;border-color:rgba(229,130,122,.4)}
#list h4{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
@keyframes in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
#card{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;
 text-align:center;background:radial-gradient(900px 500px at 50% 40%,#211a10 0%,#0a0b0d 70%);opacity:0;transition:opacity .7s}
#card.on{opacity:1}
#card .k{font-size:15px;letter-spacing:.32em;text-transform:uppercase;color:var(--gold);font-weight:800}
#card h1{margin-top:22px;font-size:86px;font-weight:800;letter-spacing:-2.5px;line-height:1.02;max-width:1500px}
#card h1 em{font-style:normal;color:var(--gold)}
#card p{margin-top:26px;font-size:25px;color:#c4c8cf;max-width:1200px;line-height:1.5}
#card .grid{margin-top:40px;display:grid;grid-template-columns:repeat(3,380px);gap:14px;text-align:left}
#card .grid div{padding:16px 18px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:17px;color:#dfe2e6}
#card .grid b{display:block;color:var(--gold);font-size:13px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}
.ripple{position:absolute;z-index:30;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;pointer-events:none;
 border:3px solid var(--gold);background:rgba(217,183,121,.28);animation:rp .75s ease-out forwards}
@keyframes rp{from{transform:scale(.25);opacity:1}to{transform:scale(1.5);opacity:0}}
.toast{position:absolute;z-index:31;padding:10px 16px;border-radius:12px;font-size:15px;font-weight:700;
 background:rgba(98,212,154,.14);border:1px solid rgba(98,212,154,.45);color:#9be6bc;animation:tin 2.6s ease forwards}
body.owner #checks,body.owner #list{display:none!important}
.brand img{display:block;height:44px;width:auto;border-radius:9px;box-shadow:0 4px 14px rgba(0,0,0,.35)}
#card img.logo{display:none;height:150px;width:auto;margin-bottom:38px;border-radius:22px;box-shadow:0 18px 50px rgba(0,0,0,.5)}
#card.haslogo img.logo{display:block}
@keyframes tin{0%{opacity:0;transform:translateY(8px)}12%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
</style></head><body>
<div id="top"><div class="brand"><b>D</b>DineOS</div><div id="chapter"></div><div id="checks">0 checks</div></div>
<div id="cap" class="fade"><span class="k"></span><div><h2></h2><p></p></div></div>
<div id="list"></div>
<div id="card"><img class="logo" alt=""><div class="k"></div><h1></h1><p></p><div class="grid"></div></div>
<script>
const panes={};let pass=0,fail=0;const recent=[];
window.__reg=(id,kind,label,vw,vh)=>{
  const el=document.createElement('div');el.className='pane '+kind;
  const cv=document.createElement('canvas');cv.width=vw;cv.height=vh;
  let url=null;
  if(kind==='desk'){const bar=document.createElement('div');bar.className='bar';
    bar.innerHTML="<span class='dot' style='background:#ff5f57'></span><span class='dot' style='background:#febc2e'></span><span class='dot' style='background:#28c840'></span><span class='who'></span><span class='url'></span>";
    el.appendChild(bar);url=bar.querySelector('.url');bar.querySelector('.who').textContent=label;el.appendChild(cv);
  } else {el.appendChild(cv);const w=document.createElement('div');w.className='who';w.textContent=label;el.appendChild(w);}
  document.body.appendChild(el);panes[id]={el,cv,ctx:cv.getContext('2d'),vw,vh,url,kind};
};
window.__url=(id,u)=>{const p=panes[id];if(p&&p.url)p.url.textContent=u;};
window.__frames=async(b)=>{for(const id in b){const p=panes[id];if(!p)continue;
  try{const bl=await (await fetch('data:image/jpeg;base64,'+b[id])).blob();const bm=await createImageBitmap(bl);
  if(p.cv.width!==bm.width||p.cv.height!==bm.height){p.cv.width=bm.width;p.cv.height=bm.height;}
  p.ctx.drawImage(bm,0,0);bm.close();}catch(e){}}};
const PH=440,K=780;
const L={
 none:{p:{}},
 admin:{p:{admin:[240,74,1440]},cap:['lower',240,940,1440]},
 kitchen:{p:{kitchen:[240,74,1440]},cap:['lower',240,940,1440]},
 manager:{p:{manager:[240,74,1440]},cap:['lower',240,940,1440]},
 guest:{p:{guest:[500,74,PH]},cap:['side',1050,330,720]},
 guest2:{p:{guest2:[500,74,PH]},cap:['side',1050,330,720]},
 trio:{p:{guest:[40,74,PH],kitchen:[520,74,K],manager:[520,560,K]},cap:['side',1340,96,540],list:[1340,470]},
 trio2:{p:{guest2:[40,74,PH],kitchen:[520,74,K],manager:[520,560,K]},cap:['side',1340,96,540],list:[1340,470]},
 avail:{p:{guest2:[40,74,PH],admin:[520,74,1360]},cap:['lower',520,900,1360]},
 duo:{p:{guest:[40,74,PH],admin:[520,74,1360]},cap:['lower',520,900,1360]},
};
window.__layout=(n)=>{const l=L[n];for(const id in panes){const p=panes[id],r=l.p[id];
  if(r){p.el.style.left=r[0]+'px';p.el.style.top=r[1]+'px';p.el.style.width=r[2]+'px';p.el.classList.add('on');}
  else p.el.classList.remove('on');}
  const c=document.getElementById('cap');
  if(l.cap){c.className=l.cap[0]+(c.classList.contains('fade')?' fade':'');c.style.left=l.cap[1]+'px';c.style.top=l.cap[2]+'px';c.style.width=l.cap[3]+'px';}
  const li=document.getElementById('list');
  if(l.list){li.style.left=l.list[0]+'px';li.style.top=l.list[1]+'px';li.style.width='540px';li.classList.add('on');}else li.classList.remove('on');
};
window.__cap=(k,t,s)=>{const c=document.getElementById('cap');c.classList.add('fade');
  setTimeout(()=>{c.querySelector('.k').textContent=k||'';c.querySelector('h2').textContent=t||'';
  c.querySelector('p').textContent=s||'';if(t)c.classList.remove('fade');},350);};
window.__chapter=(t)=>{document.getElementById('chapter').textContent=t;};
window.__check=(name,ok)=>{ok?pass++:fail++;const el=document.getElementById('checks');
  el.textContent=pass+' checks passed'+(fail?' · '+fail+' failed':'');el.classList.toggle('bad',!!fail);
  recent.push([name,ok]);if(recent.length>9)recent.shift();
  const li=document.getElementById('list');li.innerHTML='<h4>Live test results</h4>'+recent.map(r=>
   "<div class='it"+(r[1]?'':' bad')+"'><span class='ic'>"+(r[1]?'✓':'✗')+"</span><span>"+r[0].replace(/[<>&]/g,'')+"</span></div>").join('');};
window.__card=(k,t,s,grid)=>{const c=document.getElementById('card');c.querySelector('.k').textContent=k||'';
  c.querySelector('h1').innerHTML=t||'';c.querySelector('p').textContent=s||'';
  c.querySelector('.grid').innerHTML=(grid||[]).map(g=>'<div><b>'+g[0]+'</b>'+g[1]+'</div>').join('');c.classList.add('on');};
window.__logo=(u)=>{const b=document.querySelector('.brand');b.innerHTML='';const i=new Image();i.src=u;i.alt='DineOS';b.appendChild(i);
  const c=document.getElementById('card');c.querySelector('img.logo').src=u;c.classList.add('haslogo');};
window.__uncard=()=>document.getElementById('card').classList.remove('on');
window.__tap=(id,x,y)=>{const p=panes[id];if(!p)return;const r=p.cv.getBoundingClientRect();const s=r.width/p.vw;
  const d=document.createElement('div');d.className='ripple';d.style.left=(r.left+x*s)+'px';d.style.top=(r.top+y*s)+'px';
  document.body.appendChild(d);setTimeout(()=>d.remove(),900);};
window.__toast=(id,text)=>{const p=panes[id];if(!p)return;const r=p.el.getBoundingClientRect();
  const d=document.createElement('div');d.className='toast';d.textContent=text;d.style.left=(r.left+16)+'px';d.style.top=(r.bottom-60)+'px';
  document.body.appendChild(d);setTimeout(()=>d.remove(),2700);};
</script></body></html>"""


# ── Video recorder (stage screencast → ffmpeg) ──────────────────────────────
class Recorder:
    def __init__(self, page, path, fps=25):
        self.page, self.path, self.fps = page, path, fps
        self.latest = None
        self.running = False
        self.frames = 0

    async def start(self):
        if not FFMPEG:
            print("! ffmpeg with libvpx not found; video disabled", flush=True)
            return
        self.ff = subprocess.Popen(
            [FFMPEG, "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg",
             "-framerate", str(self.fps), "-i", "pipe:0", "-c:v", "libvpx",
             "-b:v", "7M", "-crf", "6", "-qmin", "0", "-qmax", "34", "-deadline", "realtime",
             "-cpu-used", "5", "-threads", "8", "-auto-alt-ref", "0", "-pix_fmt", "yuv420p",
             self.path],
            stdin=subprocess.PIPE,
        )
        self.cdp = await self.page.context.new_cdp_session(self.page)
        self.cdp.on("Page.screencastFrame", self._on_frame)
        await self.cdp.send("Page.startScreencast", {
            "format": "jpeg", "quality": 90, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})
        self.running = True
        self.task = asyncio.create_task(self._writer())

    def _on_frame(self, params):
        self.latest = base64.b64decode(params["data"])
        asyncio.create_task(self._ack(params["sessionId"]))

    async def _ack(self, sid):
        try:
            await self.cdp.send("Page.screencastFrameAck", {"sessionId": sid})
        except Exception:
            pass

    async def _writer(self):
        loop = asyncio.get_running_loop()
        nxt = time.perf_counter()
        while self.running:
            if self.latest:
                data = self.latest
                try:
                    await loop.run_in_executor(None, self.ff.stdin.write, data)
                    self.frames += 1
                except Exception:
                    break
            nxt += 1.0 / self.fps
            await asyncio.sleep(max(0, nxt - time.perf_counter()))

    async def stop(self):
        if not self.running:
            return
        self.running = False
        await self.task
        try:
            await self.cdp.send("Page.stopScreencast")
        except Exception:
            pass
        self.ff.stdin.close()
        await asyncio.get_running_loop().run_in_executor(None, self.ff.wait)


# ── Pane relay (role screens → stage canvases) ──────────────────────────────
class Relay:
    def __init__(self, stage):
        self.stage = stage
        self.pending = {}
        self.sessions = {}
        self.running = True

    async def attach(self, pane, page, kind, label, vp, max_w):
        await self.stage.evaluate("a=>window.__reg(a[0],a[1],a[2],a[3],a[4])",
                                  [pane, kind, label, vp["width"], vp["height"]])
        await self.retarget(pane, page, max_w)

    async def retarget(self, pane, page, max_w):
        old = self.sessions.pop(pane, None)
        if old:
            try:
                await old.send("Page.stopScreencast")
                await old.detach()
            except Exception:
                pass
        cdp = await page.context.new_cdp_session(page)
        self.sessions[pane] = cdp

        def on_frame(params, pane=pane, cdp=cdp):
            self.pending[pane] = params["data"]
            asyncio.create_task(self._ack(cdp, params["sessionId"]))

        cdp.on("Page.screencastFrame", on_frame)
        await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 82,
                                                "maxWidth": max_w, "maxHeight": 2000, "everyNthFrame": 1})

        def on_nav(frame, pane=pane, page=page):
            if frame == page.main_frame:
                u = frame.url.replace(BASE, "")
                asyncio.create_task(self._safe_eval("a=>window.__url(a[0],a[1])", [pane, u or "/"]))

        page.on("framenavigated", on_nav)

    async def _ack(self, cdp, sid):
        try:
            await cdp.send("Page.screencastFrameAck", {"sessionId": sid})
        except Exception:
            pass

    async def _safe_eval(self, js, arg):
        try:
            await self.stage.evaluate(js, arg)
        except Exception:
            pass

    async def pump(self):
        while self.running:
            if self.pending:
                batch, self.pending = self.pending, {}
                await self._safe_eval("b=>window.__frames(b)", batch)
            await asyncio.sleep(0.05)


# ── Test bookkeeping ────────────────────────────────────────────────────────
RESULTS = []
STATE = {"chapter": ""}
STAGE = {"page": None}
PAGES = {}


async def stage(js, arg=None):
    try:
        await STAGE["page"].evaluate(js, arg)
    except Exception:
        pass


async def check(name, awaitable):
    t = time.time()
    ok, err = True, ""
    try:
        if asyncio.iscoroutine(awaitable) or isinstance(awaitable, asyncio.Future):
            res = await awaitable
            if res is False:
                raise AssertionError("condition was false")
        elif awaitable is False:
            raise AssertionError("condition was false")
    except Exception as e:  # noqa: BLE001 - record any failure
        ok = False
        err = "%s: %s" % (type(e).__name__, (str(e).strip().splitlines() or [""])[0][:300])
    RESULTS.append({"chapter": STATE["chapter"], "check": name, "ok": ok, "error": err,
                    "secs": round(time.time() - t, 1)})
    print(("  PASS  " if ok else "  FAIL  ") + name + ("  -> " + err if err else ""), flush=True)
    await stage("a=>window.__check(a[0],a[1])", [name, ok])
    if not ok:
        await snapshot_failure(name)
    return ok


async def snapshot_failure(name):
    os.makedirs(FAIL_DIR, exist_ok=True)
    safe = re.sub(r"[^a-z0-9]+", "-", name.lower())[:60]
    for pane, page in list(PAGES.items()):
        try:
            if not page.is_closed():
                await page.screenshot(path=os.path.join(FAIL_DIR, "%s-%s.png" % (safe, pane)))
        except Exception:
            pass


def soft(coro_fn):
    """Run a chapter; record an unexpected crash as a failed check and go on."""
    async def run(*a, **k):
        try:
            return await coro_fn(*a, **k)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            await check("%s completed without errors" % STATE["chapter"], _raise(e))
    return run


async def _raise(e):
    raise e


async def beat(s=1.0):
    await asyncio.sleep(s)


async def cap(kicker, title, sub=""):
    await stage("a=>window.__cap(a[0],a[1],a[2])", [kicker, title, sub])


async def layout(name):
    await stage("n=>window.__layout(n)", name)
    await beat(0.9)


async def chapter(num, title):
    STATE["chapter"] = title
    print("\n== %s. %s" % (num, title), flush=True)
    await stage("t=>window.__chapter(t)", "%02d · %s" % (num, title))


async def card(kicker, title, sub="", grid=None, secs=3.2, keep=False):
    await stage("a=>window.__card(a[0],a[1],a[2],a[3])", [kicker, title, sub, grid or []])
    await beat(secs)
    if keep:  # closing card: stays on screen until the recording stops
        return
    await stage("()=>window.__uncard()")
    await beat(0.6)


async def tap(pane, loc, pause=0.35, timeout=20000):
    await loc.wait_for(state="visible", timeout=timeout)
    await loc.scroll_into_view_if_needed(timeout=timeout)
    box = await loc.bounding_box()
    if box:
        await stage("a=>window.__tap(a[0],a[1],a[2])",
                    [pane, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2])
    await beat(pause)
    await loc.click(timeout=timeout)


async def type_in(pane, loc, text, delay=45, clear=True):
    await tap(pane, loc)
    if clear:
        await loc.fill("")
    await loc.press_sequentially(text, delay=delay)


async def smooth_scroll(page, y, el_selector=None):
    js = ("a=>{const e=a[1]?document.querySelector(a[1]):null;(e||window).scrollTo({top:a[0],behavior:'smooth'})}")
    await page.evaluate(js, [y, el_selector])
    await beat(1.0)


def decode_qr(png_bytes):
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    return [r.text for r in zxingcpp.read_barcodes(img)]


def menu_row(page, name):
    return page.locator(".wa-menu-item").filter(
        has=page.locator(".wa-mi-name", has_text=re.compile("^%s$" % re.escape(name))))


async def send_chat(page, pane, text):
    box = page.locator('.wa-footer input[aria-label="Message"]')
    await type_in(pane, box, text, delay=55)
    await beat(0.3)
    await box.press("Enter")


async def wait_bot_reply(page, before, timeout=60000):
    await page.wait_for_function(
        "n=>{const b=[...document.querySelectorAll('.wa-msg.bot .wa-bubble')];"
        "if(b.length<=n)return false;const t=b[b.length-1].textContent.trim();return t&&t!=='…';}",
        arg=before, timeout=timeout)
    return (await page.locator(".wa-msg.bot .wa-bubble").last.inner_text()).strip()


async def bot_count(page):
    return await page.locator(".wa-msg.bot .wa-bubble").count()


# ── Scenario ────────────────────────────────────────────────────────────────
CTX = {}


def keep_awake(on):
    """Ask Windows not to sleep while the run is in progress.

    A sleep mid-run expires the 1-hour staff cookies and guest sessions and
    drops the DB connection, which shows up as bogus failures. The request is
    process-scoped: Windows drops it automatically when this script exits, and
    no power settings are changed.
    """
    if os.name != "nt":
        return
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x00000001, 0x00000002
        flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED if on else 0)
        ctypes.windll.kernel32.SetThreadExecutionState(flags)
    except Exception:
        pass


async def main():
    started = datetime.now()
    keep_awake(True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])

        stage_ctx = await browser.new_context(viewport={"width": 1920, "height": 1080})
        stage_page = await stage_ctx.new_page()
        await stage_page.set_content(STAGE_HTML)
        STAGE["page"] = stage_page
        logo = logo_data_url()
        if logo:
            await stage_page.evaluate("u=>window.__logo(u)", logo)
            await stage_page.wait_for_function("()=>{const i=document.querySelector('.brand img');return i&&i.complete}")
        relay = Relay(stage_page)
        STAGE["relay"] = relay
        pump = asyncio.create_task(relay.pump())
        rec = Recorder(stage_page, VIDEO)

        no_print = "window.print=()=>{};"
        actx = await browser.new_context(viewport=DESK, accept_downloads=True)
        kctx = await browser.new_context(viewport=DESK)
        mctx = await browser.new_context(viewport=DESK, accept_downloads=True)
        for c in (actx, kctx, mctx):
            await c.add_init_script(no_print)
        phone_opts = dict(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True,
                          user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
                                      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"))
        gctx = await browser.new_context(**phone_opts)
        g2ctx = await browser.new_context(**phone_opts)
        CTX.update(admin=actx, kitchen=kctx, manager=mctx, guest=gctx, guest2=g2ctx)

        admin = await actx.new_page()
        kitchen = await kctx.new_page()
        manager = await mctx.new_page()
        guest = await gctx.new_page()
        guest2 = await g2ctx.new_page()
        PAGES.update(admin=admin, kitchen=kitchen, manager=manager, guest=guest, guest2=guest2)
        for p in PAGES.values():
            p.on("dialog", lambda d: asyncio.create_task(d.accept()))

        await relay.attach("admin", admin, "desk", "Admin · Anita", DESK, 1280)
        await relay.attach("kitchen", kitchen, "desk", "Kitchen · Shubu", DESK, 1280)
        await relay.attach("manager", manager, "desk", "Manager · Tushar", DESK, 1280)
        await relay.attach("guest", guest, "phone", "Guest · Table " + TABLE, PHONE, 780)
        await relay.attach("guest2", guest2, "phone", "Takeaway guest · Riya", PHONE, 780)

        ctx = {}
        if OWNER:
            await stage("()=>document.body.classList.add('owner')")
            try:
                await owner_setup(admin, kitchen, manager)
                await rec.start()
                await owner_flow(admin, kitchen, manager, guest, ctx)
            finally:
                await rec.stop()  # stop first so cleanup never appears on camera
                await restore_availability(actx)
                relay.running = False
                await pump
                await browser.close()
                keep_awake(False)
            write_report(started)
            return
        await rec.start()
        try:
            await intro()
            await ch_admin(admin, ctx)
            await ch_qr(admin, ctx)
            await ch_staff_login(kitchen, manager, ctx)
            await ch_guest_order(guest, ctx)
            await ch_live_kitchen(guest, kitchen, manager, ctx)
            await ch_second_round(guest, kitchen, manager, ctx)
            await ch_bill_pay(guest, manager, ctx)
            await ch_takeaway_availability(guest2, admin, kitchen, manager, ctx)
            await ch_manager_tools(manager, mctx, ctx)
            await ch_reports_settings(admin, ctx)
            await ch_logout(admin, kitchen, manager)
            await outro()
        finally:
            await restore_availability(actx)
            await rec.stop()
            relay.running = False
            await pump
            await browser.close()
            keep_awake(False)
    write_report(started)


async def intro():
    await chapter(0, "DineOS")
    await card("End-to-end product demo", "Better service.<br><em>Less waiting.</em>",
               "One real restaurant, four real logins. Every step below is a live, automated test against the running app.",
               [["Guest", "QR ordering, AI waiter, serving order, live tracking, UPI pay"],
                ["Kitchen", "Ticket board, per-dish workflow, cancellations"],
                ["Manager & Admin", "Open table bills, settle, availability, QR, reports, staff"]],
               secs=5.5)


@soft
async def ch_admin(admin, ctx):
    await chapter(1, "Admin sign-in")
    await admin.goto(BASE + "/login.html")
    await layout("admin")
    await cap("Admin console", "Anita signs in to her merchant console",
              "Owners manage the restaurant, menu, tables, payments and team from one place.")
    await type_in("admin", admin.locator("#loginEmail"), ADMIN[0])
    await type_in("admin", admin.locator("#loginPassword"), ADMIN[1], delay=30)
    await tap("admin", admin.get_by_role("button", name="Sign in to DineOS"))
    await check("Admin login opens the admin console",
                admin.wait_for_url(re.compile(r"/admin\.html"), timeout=20000))
    await check("Restaurant is already configured (edit mode shown)",
                expect(admin.locator("#editMode")).to_be_visible(timeout=20000))
    await beat(1.2)
    await cap("Restaurant settings", "Info, tables & zones, menu and payments",
              "Each section expands inline. Nothing here needs a developer.")
    for sec in ("info", "tables", "menu", "payment"):
        await tap("admin", admin.locator("#em-section-%s .edit-section-toggle" % sec))
        await beat(1.3)
    upi = admin.locator("#em-upi")
    await upi.scroll_into_view_if_needed()
    await cap("Payments", "UPI ID and payment mode are configured here",
              "This UPI ID is what the guest's payment QR pays into. Postpaid = order first, pay the final bill.")
    await beat(1.5)
    ctx["upi"] = await upi.input_value()

    async def _upi():
        assert "@" in ctx["upi"], "UPI id missing: %r" % ctx["upi"]
    await check("UPI ID is configured (%s)" % (ctx["upi"] or "none"), _upi())
    ctx["mode"] = await admin.locator("#em-paymentMode").input_value()
    await check("Payment mode is %s" % ctx["mode"], _true(ctx["mode"] in ("prepaid", "postpaid")))
    await beat(1.5)


async def _true(v):
    if not v:
        raise AssertionError("expected truthy")
    return True


@soft
async def ch_qr(admin, ctx):
    await chapter(2, "Table & takeaway QR codes")
    await admin.goto("%s/qr.html?r=%s" % (BASE, SLUG))
    await cap("QR codes", "Every table gets its own secure QR code",
              "The QR holds an opaque token, never the restaurant slug, so guests can't tamper with table numbers.")
    await beat(1.0)
    await type_in("admin", admin.locator("#table"), TABLE)
    await tap("admin", admin.locator("#go"))
    await check("Table QR generated for table %s" % TABLE,
                expect(admin.locator("#qrcode img, #qrcode canvas").first).to_be_attached(timeout=15000))
    await expect(admin.locator("#title")).to_have_text("Table " + TABLE, timeout=10000)
    ctx["table_link"] = (await admin.locator("#link").inner_text()).strip()
    await check("Table QR link uses an opaque token", _true(re.search(r"/\?r=[A-Za-z0-9_-]{8,}$", ctx["table_link"])))
    await beat(1.8)
    if HAVE_QR:
        png = await admin.locator("#qrcode").screenshot()
        got = decode_qr(png)
        await check("Table QR decodes to the table link", _true(got and got[0] == ctx["table_link"]))
    await tap("admin", admin.locator("#takeaway"))
    await check("Takeaway QR generated",
                expect(admin.locator("#title")).to_have_text("Takeaway QR", timeout=15000))
    ctx["takeaway_link"] = (await admin.locator("#link").inner_text()).strip()
    await check("Takeaway QR link carries takeaway=1", _true(ctx["takeaway_link"].endswith("&takeaway=1")))
    if HAVE_QR:
        png = await admin.locator("#qrcode").screenshot()
        got = decode_qr(png)
        await check("Takeaway QR decodes to the takeaway link", _true(got and got[0] == ctx["takeaway_link"]))
    await beat(1.8)


@soft
async def ch_staff_login(kitchen, manager, ctx):
    await chapter(3, "Staff portals")
    await kitchen.goto(BASE + "/kitchen-login")
    await layout("kitchen")
    await cap("Kitchen portal", "Kitchen staff sign in with their own account",
              "Roles are enforced server-side: the kitchen only sees the ticket board.")
    await type_in("kitchen", kitchen.locator("#username"), KITCHEN[0])
    await type_in("kitchen", kitchen.locator("#password"), KITCHEN[1], delay=30)
    await tap("kitchen", kitchen.get_by_role("button", name="Open Kitchen Portal"))
    await check("Kitchen login opens the kitchen board",
                kitchen.wait_for_url(re.compile(r"/kitchen\.html"), timeout=20000))
    await check("Kitchen role sees 'Kitchen Portal'",
                expect(kitchen.locator("h1").first).to_have_text("Kitchen Portal", timeout=15000))
    await check("Manager-only controls are hidden for kitchen",
                expect(kitchen.locator("#closeBtn")).to_be_hidden(timeout=5000))
    await beat(1.5)

    await manager.goto(BASE + "/manager-login")
    await layout("manager")
    await cap("Manager portal", "The floor manager signs in",
              "Managers see every order, open table bills, payments and exports.")
    await type_in("manager", manager.locator("#email"), MANAGER[0])
    await type_in("manager", manager.locator("#password"), MANAGER[1], delay=30)
    await tap("manager", manager.get_by_role("button", name="Open Manager Portal"))
    await check("Manager login opens the manager dashboard",
                manager.wait_for_url(re.compile(r"/manager\.html"), timeout=20000))
    await check("Manager KPIs render", expect(manager.locator("#summary .kpi").first).to_be_visible(timeout=20000))
    await beat(1.5)


@soft
async def ch_guest_order(guest, ctx):
    await chapter(4, "Guest ordering")
    if not ctx.get("table_link"):
        raise AssertionError("no table QR link from chapter 2")
    await layout("guest")
    await cap("Guest · scans the table QR", "No app, no login. The menu opens in the browser",
              "The QR token resolves the table on the server and starts a private, device-bound session.")
    await guest.goto(ctx["table_link"])
    await check("Guest session starts from the QR",
                expect(guest.locator('.wa-footer input[aria-label="Message"]')).to_be_visible(timeout=30000))
    await check("Header shows the table from the QR",
                expect(guest.locator(".wa-title small")).to_contain_text("Table " + TABLE, timeout=10000))
    await beat(1.5)
    await tap("guest", guest.locator(".wa-quick .wa-chip", has_text="Show Menu"))
    await check("Menu loads all dishes", expect(guest.locator(".wa-menu-item")).to_have_count(25, timeout=20000))
    await cap("Mobile-first menu", "Sticky search and category chips",
              "Large touch targets, gold prices, muted descriptions: built for one-handed use in a dim room.")
    await check("Search + categories stay sticky",
                _true(await guest.locator(".wa-menu-head").evaluate("e=>getComputedStyle(e).position") == "sticky"))
    h = await guest.locator(".wa-add").first.evaluate("e=>e.getBoundingClientRect().height")
    await check("Add button is a 44px+ touch target (%dpx)" % h, _true(h >= 44))
    await beat(1.2)
    await tap("guest", guest.locator(".wa-cat-chips .wa-chip", has_text=re.compile(r"^Coffee$")))
    await beat(0.6)
    await check("Category chip filters to Coffee (4 dishes)",
                expect(guest.locator(".wa-menu-item:visible")).to_have_count(4, timeout=5000))
    await beat(1.4)
    await tap("guest", guest.locator(".wa-cat-chips .wa-chip", has_text=re.compile(r"^Pizza$")))
    await beat(1.4)
    await tap("guest", guest.locator(".wa-cat-chips .wa-chip", has_text=re.compile(r"^All$")))
    await type_in("guest", guest.locator(".wa-menu-search"), "choc", delay=90)
    await beat(0.6)
    await check("Search finds chocolate dishes",
                expect(guest.locator(".wa-menu-item:visible")).to_have_count(2, timeout=5000))
    await beat(1.2)
    await guest.locator(".wa-menu-search").fill("")
    await guest.locator(".wa-menu-search").dispatch_event("input")
    await beat(0.6)

    await cap("Guest · builds the order", "One tap to add, a stepper to adjust",
              "The floating order bar appears the moment something is added.")
    for name in ("Cappuccino", "Margherita Pizza", "Chocolate Brownie"):
        await tap("guest", menu_row(guest, name).locator(".wa-add"))
        await beat(0.7)
    await tap("guest", guest.locator('[aria-label="Increase Cappuccino"]').first)
    await check("Stepper increases Cappuccino to 2",
                expect(menu_row(guest, "Cappuccino").locator(".wa-qty-n")).to_have_text("2", timeout=5000))
    await check("Floating order summary shows 4 items",
                expect(guest.locator(".wa-cart-badge")).to_contain_text("4 items", timeout=5000))
    await beat(1.5)

    await cap("AI waiter", "Ask anything about the menu",
              "Answers come from this restaurant's own menu (retrieval + LLM).")
    before = await bot_count(guest)
    await send_chat(guest, "guest", "Is there something light and refreshing without caffeine?")
    try:
        ans = await wait_bot_reply(guest, before, timeout=60000)
    except Exception:
        ans = ""
    await check("AI waiter answers a menu question", _true(len(ans) > 20 and "something went wrong" not in ans.lower()))
    await beat(3.5)

    await cap("Natural-language ordering", "Just type what you want",
              "\"2 masala chai please\" goes straight into the order.")
    before = await bot_count(guest)
    await send_chat(guest, "guest", "2 masala chai please")
    reply = await wait_bot_reply(guest, before, timeout=20000)
    await check("Typed order adds 2 × Masala Chai", _true("2 × Masala Chai" in reply))
    await check("Order summary updates to 6 items",
                expect(guest.locator(".wa-cart-badge")).to_contain_text("6 items", timeout=5000))
    await beat(1.6)

    await cap("Only on DineOS", "Guests choose the order their food arrives",
              "Tea first, pizza next, dessert last. The kitchen sees the same sequence on every ticket.")
    await tap("guest", guest.locator(".wa-cart-badge"))
    await check("Cart lists 4 dishes", expect(guest.locator(".wa-cart-card .wa-cart-row")).to_have_count(4, timeout=8000))
    for _ in range(3):
        await tap("guest", guest.locator('.wa-cart-card [aria-label="Move Masala Chai up"]'))
        await beat(0.8)
    first = guest.locator(".wa-cart-card .wa-cart-row").first
    await check("Masala Chai moved to 'Serve First'", expect(first).to_contain_text("Serve First", timeout=5000))
    await check("Serving order starts with Masala Chai", expect(first).to_contain_text("Masala Chai", timeout=5000))
    await type_in("guest", guest.locator('.wa-cart-card [aria-label="Instructions for Margherita Pizza"]'),
                  "Extra crispy, no olives", delay=50)
    await beat(1.0)
    await tap("guest", guest.locator(".wa-cart-card button[data-order-submit]", has_text="Place order"))
    await check("Order is placed", expect(guest.locator(".wa-order-card .wa-order-no").last).to_be_visible(timeout=20000))
    ctx["order1"] = (await guest.locator(".wa-order-card .wa-order-no").last.inner_text()).replace("Order", "").strip()
    await cap("Order placed", "Order %s is on its way to the kitchen" % ctx["order1"],
              "Postpaid: it's added to the open table bill. The guest pays once at the end.")
    await beat(2.5)
    await stage_still("e2e-01-guest-order.png")


@soft
async def ch_live_kitchen(guest, kitchen, manager, ctx):
    await chapter(5, "Live service")
    no = ctx.get("order1")
    if not no:
        raise AssertionError("no order from chapter 4")
    await layout("trio")
    await cap("Real time", "Guest, kitchen and manager stay in sync",
              "Every status change is pushed live. Nobody refreshes anything.")
    kcard = kitchen.locator(".card", has_text=no)
    await check("Kitchen receives order %s live" % no, expect(kcard).to_be_visible(timeout=25000))
    await check("Kitchen ticket shows the guest's serving order",
                expect(kcard.locator(".item-row").first).to_contain_text("Masala Chai", timeout=5000))
    await check("Kitchen ticket shows the dish note",
                expect(kcard.locator(".item-note")).to_contain_text("Extra crispy", timeout=5000))
    await check("Manager sees the new order", expect(manager.locator(".bill", has_text=no)).to_be_visible(timeout=25000))
    await tap("guest", guest.locator(".wa-dock .wa-chip", has_text="Track Order"))
    await check("Guest sees live order tracking", expect(guest.locator(".wa-status-card").last).to_be_visible(timeout=15000))
    await beat(1.2)

    await cap("Kitchen · per-dish workflow", "Accept, cook, ready, served",
              "Each dish moves on its own, so drinks don't wait for the pizza.")
    await tap("kitchen", kcard.locator("button.b-advance-all", has_text=re.compile(r"^Accept all")))
    await check("Kitchen accepts all dishes",
                expect(kcard.locator(".item-pill.item-st-accepted")).to_have_count(4, timeout=10000))
    gstatus = guest.locator(".wa-status-card").last
    await check("Guest sees dishes accepted",
                expect(gstatus.locator(".wa-status-item", has_text="Masala Chai").locator(".wa-item-status"))
                .to_have_text(re.compile("accepted", re.I), timeout=20000))
    chai = kcard.locator(".item-row", has_text="Masala Chai")
    for label, pill in (("Start cooking", "Preparing"), ("Mark ready", "Ready"), ("Mark served", "Served")):
        await tap("kitchen", chai.locator("button.item-advance", has_text=label))
        await expect(chai).to_contain_text(pill, timeout=10000)
        await beat(1.0)
    await check("Masala Chai served first, on its own",
                expect(gstatus.locator(".wa-status-item", has_text="Masala Chai").locator(".wa-item-status"))
                .to_have_text(re.compile("served", re.I), timeout=20000))
    await beat(1.0)

    await cap("Guest · changed their mind", "Cancel a dish before it's cooked",
              "Cancel is offered only while a dish is pending or accepted.")
    brownie = gstatus.locator(".wa-status-item", has_text="Chocolate Brownie")
    await tap("guest", brownie.locator(".wa-item-cancel"))
    await check("Guest cancels the brownie",
                expect(guest.locator(".wa-msg.bot", has_text='"Chocolate Brownie" cancelled')).to_be_visible(timeout=15000))
    await check("Kitchen sees the brownie cancelled",
                expect(kcard.locator(".item-row", has_text="Chocolate Brownie")).to_contain_text("Cancelled", timeout=20000))
    await beat(1.2)

    await cap("Kitchen · bulk actions", "Move the rest of the ticket in one tap", "")
    for label in ("Start cooking all", "Mark ready all", "Mark served all"):
        btn = kcard.locator("button.b-advance-all", has_text=re.compile("^" + label))
        await tap("kitchen", btn)
        await beat(1.4)
    await check("Served tickets clear off the kitchen board", expect(kcard).to_have_count(0, timeout=20000))
    await check("Guest's order shows Served",
                expect(guest.locator(".wa-status-card").last.locator(".wa-status-badge").first)
                .to_have_text(re.compile("Served", re.I), timeout=25000))
    await beat(1.5)
    await stage_still("e2e-02-live-service.png")


@soft
async def ch_second_round(guest, kitchen, manager, ctx):
    await chapter(6, "Second round")
    await layout("trio")
    await cap("Guest · orders again", "Another round on the same table bill",
              "Every order in the session lands on one open table bill.")
    before = await bot_count(guest)
    await send_chat(guest, "guest", "1 fresh lime soda")
    reply = await wait_bot_reply(guest, before, timeout=20000)
    await check("Typed order adds Fresh Lime Soda", _true("Fresh Lime Soda" in reply))
    await tap("guest", guest.locator(".wa-cart-badge"))
    await tap("guest", guest.locator(".wa-cart-card button[data-order-submit]", has_text="Place order").last)
    await expect(guest.locator(".wa-order-card .wa-order-no").last).not_to_have_text("Order " + ctx.get("order1", "?"),
                                                                                     timeout=20000)
    ctx["order2"] = (await guest.locator(".wa-order-card .wa-order-no").last.inner_text()).replace("Order", "").strip()
    await check("Second order %s placed" % ctx["order2"], _true(ctx["order2"] and ctx["order2"] != ctx.get("order1")))
    kcard = kitchen.locator(".card", has_text=ctx["order2"])
    await check("Kitchen receives the second order", expect(kcard).to_be_visible(timeout=25000))
    for label in ("Accept all", "Start cooking all", "Mark ready all", "Mark served all"):
        await tap("kitchen", kcard.locator("button.b-advance-all", has_text=re.compile("^" + label)))
        await beat(1.1)
    await check("Second order served", expect(kcard).to_have_count(0, timeout=20000))
    await check("Manager groups both orders into one open table bill",
                expect(manager.locator(".session-bill", has_text=ctx["order2"])).to_be_visible(timeout=25000))
    await beat(2.0)


@soft
async def ch_bill_pay(guest, manager, ctx):
    await chapter(7, "Bill & UPI payment")
    await layout("guest")
    await cap("Guest · asks for the bill", "One bill for the whole table",
              "Taxes are computed server-side from the stored menu, never from client prices.")
    await tap("guest", guest.locator(".wa-dock .wa-chip", has_text="Get Bill"))
    await check("Bill is shown", expect(guest.locator(".wa-bill table").last).to_be_visible(timeout=20000))
    await beat(2.0)
    await tap("guest", guest.locator("button.wa-btn", has_text="Pay bill").last)
    qr = guest.locator(".wa-pay-card .wa-qr").last
    await check("Payment QR renders", expect(qr.locator("img, canvas").first).to_be_attached(timeout=20000))
    await qr.scroll_into_view_if_needed()
    await beat(1.0)
    await cap("Scan to pay", "A UPI QR any app can read",
              "White quiet zone, whole-pixel modules, amount pre-filled. GPay, PhonePe, Paytm and BHIM all work.")
    style = await qr.evaluate("e=>{const s=getComputedStyle(e);return [s.backgroundColor,parseFloat(s.paddingTop)]}")
    await check("QR sits on a white quiet zone (%dpx)" % style[1], _true(style[0] in ("rgb(255, 255, 255)",) and style[1] >= 12))
    amt_txt = await guest.locator(".wa-pay-card .wa-pay-amt").last.inner_text()
    amount = float(re.sub(r"[^0-9.]", "", amt_txt) or 0)
    if HAVE_QR:
        await beat(0.5)
        got = decode_qr(await qr.screenshot())
        uri = got[0] if got else ""
        ctx["upi_uri"] = uri
        await check("Payment QR decodes as a UPI link", _true(uri.startswith("upi://pay?")))
        await check("QR pays %s with a literal @" % ctx.get("upi", "?"), _true(("pa=" + ctx.get("upi", "~")) in uri))
        m = re.search(r"[?&]am=([0-9.]+)", uri)
        await check("QR amount matches the bill (%.2f)" % amount, _true(m and abs(float(m.group(1)) - amount) < 0.01))
    await beat(3.0)
    await stage_still("e2e-03-upi-qr.png")

    await layout("trio")
    await cap("Manager · settles the table", "Mark the open table bill as paid",
              "A confirmation dialog prevents accidental settlement.")
    await tap("manager", manager.locator(".session-bill button.settle-session").first)
    await check("Settle confirmation opens", expect(manager.locator("#settleModalBg")).to_have_class(re.compile("open"), timeout=5000))
    await beat(1.2)
    await tap("manager", manager.locator("#settleConfirm"))
    await check("Guest is told the bill is paid and the table closed",
                expect(guest.locator(".wa-msg.bot", has_text="bill has been paid")).to_be_visible(timeout=40000))
    await check("Manager shows both orders PAID",
                expect(manager.locator(".bill", has_text=ctx.get("order2", "?")).locator(".pay")).to_have_text("PAID", timeout=20000))
    await beat(2.5)


@soft
async def ch_takeaway_availability(guest2, admin, kitchen, manager, ctx):
    await chapter(8, "Takeaway & live availability")
    if not ctx.get("takeaway_link"):
        raise AssertionError("no takeaway link from chapter 2")
    await layout("guest2")
    await cap("Takeaway", "Pickup guests scan the counter QR",
              "They give a name instead of a table number.")
    await guest2.goto(ctx["takeaway_link"])
    name_in = guest2.locator('.wa-footer input[aria-label="Your name"]')
    await check("Takeaway QR asks for a name", expect(name_in).to_be_visible(timeout=30000))
    await type_in("guest2", name_in, "Riya", delay=80)
    await tap("guest2", guest2.locator(".wa-footer .wa-btn", has_text="Start"))
    await check("Takeaway session starts",
                expect(guest2.locator('.wa-footer input[aria-label="Message"]')).to_be_visible(timeout=20000))
    for txt in ("1 club sandwich", "1 cappuccino"):
        before = await bot_count(guest2)
        await send_chat(guest2, "guest2", txt)
        await wait_bot_reply(guest2, before, timeout=20000)
        await beat(0.8)
    await check("Takeaway cart has 2 items", expect(guest2.locator(".wa-cart-badge")).to_contain_text("2 items", timeout=5000))

    await admin.goto("%s/availability.html?r=%s" % (BASE, SLUG))
    await layout("avail")
    await cap("Sold out?", "Mark a dish unavailable and every guest knows instantly",
              "The cappuccino machine breaks. One switch updates every open cart.")
    await type_in("admin", admin.locator("#search"), "Cappuccino", delay=60)
    await beat(0.8)
    dish = admin.locator(".dish", has_text="Cappuccino")
    await tap("admin", dish.locator("label.switch"))
    await check("Admin marks Cappuccino sold out",
                expect(admin.locator("#toast")).to_contain_text("sold out", timeout=10000))
    ctx["cappuccino_off"] = True
    await check("Guest's cart drops the sold-out dish with a message",
                expect(guest2.locator(".wa-msg.bot", has_text="just sold out")).to_be_visible(timeout=45000))
    await check("Takeaway cart now has 1 item", expect(guest2.locator(".wa-cart-badge")).to_contain_text("1 item", timeout=10000))
    await beat(2.0)
    await tap("admin", dish.locator("label.switch"))
    await check("Admin restores Cappuccino", expect(admin.locator("#toast")).to_contain_text("available", timeout=10000))
    ctx["cappuccino_off"] = False
    await beat(1.5)

    await layout("trio2")
    await cap("Takeaway · to the kitchen", "Pickup orders are tagged with the guest's name", "")
    await tap("guest2", guest2.locator(".wa-cart-badge"))
    await tap("guest2", guest2.locator(".wa-cart-card button[data-order-submit]", has_text="Place order"))
    await check("Takeaway order placed", expect(guest2.locator(".wa-order-card .wa-order-no").last).to_be_visible(timeout=20000))
    ctx["order3"] = (await guest2.locator(".wa-order-card .wa-order-no").last.inner_text()).replace("Order", "").strip()
    kcard = kitchen.locator(".card", has_text=ctx["order3"])
    await check("Kitchen shows the takeaway ticket for Riya",
                expect(kcard.locator(".badge.takeaway")).to_contain_text("Riya", timeout=25000))
    for label in ("Accept all", "Start cooking all", "Mark ready all", "Mark served all"):
        await tap("kitchen", kcard.locator("button.b-advance-all", has_text=re.compile("^" + label)))
        await beat(1.0)
    await check("Takeaway order served", expect(kcard).to_have_count(0, timeout=20000))
    bill = manager.locator(".bill", has_text=ctx["order3"])
    await expect(bill).to_be_visible(timeout=25000)
    await tap("manager", bill.locator("button.mark-paid"))
    await check("Manager marks the takeaway bill PAID", expect(bill.locator(".pay")).to_have_text("PAID", timeout=15000))
    await beat(2.0)


@soft
async def ch_manager_tools(manager, mctx, ctx):
    await chapter(9, "Manager tools")
    await layout("manager")
    await cap("Manager dashboard", "Today's orders, revenue and delays at a glance",
              "Filter by status or date, print receipts, export for accounting.")
    await smooth_scroll(manager, 0)
    await beat(1.0)
    await tap("manager", manager.locator("#status"))
    await manager.select_option("#status", "served")
    await tap("manager", manager.locator("#applyBtn"))
    await check("Status filter shows served orders",
                expect(manager.locator(".bill", has_text=ctx.get("order1", "?"))).to_be_visible(timeout=15000))
    await beat(1.5)
    await manager.select_option("#status", "")
    await tap("manager", manager.locator("#applyBtn"))
    await beat(1.0)
    await tap("manager", manager.locator("#receiptSettingsBtn"))
    await check("Receipt settings open", expect(manager.locator("#modalBg")).to_have_class(re.compile("open"), timeout=8000))
    await beat(2.2)
    await tap("manager", manager.locator("#rsCancel"))
    today = date.today().isoformat()
    r = await mctx.request.get("%s/manager/orders.csv?restaurant=%s&date_from=%s&date_to=%s" % (BASE, SLUG, today, today))
    body = await r.text()
    await check("CSV export contains today's orders", _true(r.ok and ctx.get("order1", "~") in body))
    await stage("a=>window.__toast(a[0],a[1])", ["manager", "✓ CSV export verified"])
    await smooth_scroll(manager, 900)
    await beat(1.5)


@soft
async def ch_reports_settings(admin, ctx):
    await chapter(10, "Reports & team")
    await admin.goto("%s/reports.html?r=%s" % (BASE, SLUG))
    await layout("admin")
    await cap("Analytics", "Revenue, orders, status mix and best sellers",
              "Today's demo orders already show up in the numbers.")
    await check("Reports load revenue", expect(admin.locator("#revenue")).not_to_have_text("—", timeout=25000))
    await beat(1.5)
    await tap("admin", admin.locator('.range-buttons button[data-range="today"]'))
    await beat(2.0)
    orders_txt = (await admin.locator("#orders").inner_text()).strip()
    n = int(re.sub(r"[^0-9]", "", orders_txt) or 0)
    await check("Today's report counts the new orders (%d)" % n, _true(n >= 3))
    await smooth_scroll(admin, 520)
    await beat(2.0)
    await smooth_scroll(admin, 1300)
    await beat(1.8)

    await admin.goto(BASE + "/settings.html")
    await cap("Team access", "Create and manage kitchen and manager logins",
              "Disable accounts or reset passwords in one click.")
    rows = admin.locator("#rows")
    await check("Staff directory lists kitchen and manager users",
                expect(rows).to_contain_text("kitchen", timeout=15000, ignore_case=True))
    await expect(rows).to_contain_text("manager", timeout=5000, ignore_case=True)
    await smooth_scroll(admin, 500)
    await beat(2.0)


@soft
async def ch_logout(admin, kitchen, manager):
    await chapter(11, "Sign out")
    await layout("kitchen")
    await cap("Security", "Every role signs out to its own login screen", "")
    for pane, page, url, label in (
            ("kitchen", kitchen, r"/kitchen-login", "Kitchen"),
            ("manager", manager, r"/manager-login", "Manager"),
            ("admin", admin, r"/login", "Admin")):
        await layout(pane)
        await tap(pane, page.locator("#globalLogout"))
        await check("%s logout returns to its login screen" % label,
                    page.wait_for_url(re.compile(url), timeout=15000))
        me = await page.context.request.get(BASE + "/auth/me")
        await check("%s session is invalidated on the server (/auth/me → %d)" % (label, me.status),
                    _true(me.status == 401))
        await beat(1.0)


async def outro():
    await chapter(12, "Summary")
    await layout("none")
    passed = sum(1 for r in RESULTS if r["ok"])
    total = len(RESULTS)
    chapters = []
    for r in RESULTS:
        if r["chapter"] not in [c[0] for c in chapters]:
            chapters.append([r["chapter"], 0, 0])
        for c in chapters:
            if c[0] == r["chapter"]:
                c[1] += 1 if r["ok"] else 0
                c[2] += 1
    grid = [[c[0], "%d / %d checks passed" % (c[1], c[2])] for c in chapters[:9]]
    title = ("All <em>%d</em> checks passed" % total) if passed == total else \
        ("<em>%d</em> of %d checks passed" % (passed, total))
    await card("Automated end-to-end run · %s" % datetime.now().strftime("%d %b %Y"), title,
               "Customer, kitchen, manager and admin, tested together against the live app.", grid, secs=7.0)


# ── Owner demo (DINEOS_MODE=owner) ──────────────────────────────────────────
async def owner_setup(admin, kitchen, manager):
    """Sign every role in before the camera starts (owners don't need logins)."""
    STATE["chapter"] = "Setup"
    await admin.goto(BASE + "/login.html")
    await admin.locator("#loginEmail").fill(ADMIN[0])
    await admin.locator("#loginPassword").fill(ADMIN[1])
    await admin.get_by_role("button", name="Sign in to DineOS").click()
    await check("Admin signs in", admin.wait_for_url(re.compile(r"/admin\.html"), timeout=20000))
    await admin.goto("%s/qr.html?r=%s" % (BASE, SLUG))
    await kitchen.goto(BASE + "/kitchen-login")
    await kitchen.locator("#username").fill(KITCHEN[0])
    await kitchen.locator("#password").fill(KITCHEN[1])
    await kitchen.get_by_role("button", name="Open Kitchen Portal").click()
    await check("Kitchen signs in", kitchen.wait_for_url(re.compile(r"/kitchen\.html"), timeout=20000))
    await manager.goto(BASE + "/manager-login")
    await manager.locator("#email").fill(MANAGER[0])
    await manager.locator("#password").fill(MANAGER[1])
    await manager.get_by_role("button", name="Open Manager Portal").click()
    await check("Manager signs in", manager.wait_for_url(re.compile(r"/manager\.html"), timeout=20000))
    await beat(2.0)


async def owner_flow(admin, kitchen, manager, guest, ctx):
    STATE["chapter"] = "Owner demo"
    await stage("t=>window.__chapter(t)", "")
    await card("For restaurant owners", "A waiter that <em>never misses an order</em>",
               "Guests scan, order and pay from their table. Your kitchen and your floor stay in sync, live.",
               [["Your guests", "Order from their own phone. No app to download."],
                ["Your kitchen", "Clear tickets, dish by dish, with notes."],
                ["You", "Every order and every rupee, in one place."]], secs=5.0)

    # 1 · Table QR
    await stage("t=>window.__chapter(t)", "Step 1 · Setup")
    await layout("admin")
    await cap("Step 1 · Setup", "Print one QR code for each table",
              "Each code knows its table, so every order reaches the right place.")
    await type_in("admin", admin.locator("#table"), TABLE, delay=90)
    await tap("admin", admin.locator("#go"))
    await check("Table QR generated", expect(admin.locator("#title")).to_have_text("Table " + TABLE, timeout=15000))
    ctx["table_link"] = (await admin.locator("#link").inner_text()).strip()
    if HAVE_QR:
        got = decode_qr(await admin.locator("#qrcode").screenshot())
        await check("Table QR decodes to the table link", _true(got and got[0] == ctx["table_link"]))
    await beat(2.5)

    # 2 · Guest orders
    await stage("t=>window.__chapter(t)", "Step 2 · Guests order")
    await guest.goto(ctx["table_link"])
    await layout("guest")
    await cap("Step 2 · Guests order themselves", "Scan, browse, tap to add",
              "No waiting to catch a waiter's eye. Works on any phone browser.")
    await check("Guest session starts", expect(guest.locator('.wa-footer input[aria-label="Message"]')).to_be_visible(timeout=30000))
    await beat(1.0)
    await tap("guest", guest.locator(".wa-quick .wa-chip", has_text="Show Menu"))
    await check("Menu loads", expect(guest.locator(".wa-menu-item").first).to_be_visible(timeout=20000))
    await beat(1.2)
    for chip, dish in (("Coffee", "Cappuccino"), ("Pizza", "Margherita Pizza"), ("Desserts", "Chocolate Brownie")):
        await tap("guest", guest.locator(".wa-cat-chips .wa-chip", has_text=re.compile("^%s$" % chip)))
        await beat(0.6)
        await tap("guest", menu_row(guest, dish).locator(".wa-add"))
        await beat(0.7)
        if dish == "Cappuccino":
            await tap("guest", guest.locator('[aria-label="Increase Cappuccino"]').first)
            await beat(0.5)
    await tap("guest", guest.locator(".wa-cat-chips .wa-chip", has_text=re.compile(r"^All$")))
    await check("Order bar shows 4 items", expect(guest.locator(".wa-cart-badge")).to_contain_text("4 items", timeout=5000))
    await beat(1.0)

    await cap("Built-in AI waiter", "Guests get answers right away",
              "Questions about dishes are answered from your own menu, so your staff can keep serving.")
    before = await bot_count(guest)
    await send_chat(guest, "guest", "Is there something light and refreshing without caffeine?")
    try:
        ans = await wait_bot_reply(guest, before, timeout=60000)
    except Exception:
        ans = ""
    await check("AI waiter answers", _true(len(ans) > 20 and "something went wrong" not in ans.lower()))
    await beat(3.0)
    await cap("Or just type the order", "\"2 masala chai please\"", "It goes straight into the order.")
    before = await bot_count(guest)
    await send_chat(guest, "guest", "2 masala chai please")
    reply = await wait_bot_reply(guest, before, timeout=20000)
    await check("Typed order adds Masala Chai", _true("Masala Chai" in reply))
    await beat(1.6)

    # 3 · Sold out
    await admin.goto("%s/availability.html?r=%s" % (BASE, SLUG))
    await stage("t=>window.__chapter(t)", "Something ran out?")
    await layout("duo")
    await cap("Something ran out?", "Mark it sold out in one tap",
              "It is removed from guests' orders automatically, before it reaches the kitchen.")
    await type_in("admin", admin.locator("#search"), "Chocolate Brownie", delay=55)
    await beat(0.6)
    dish = admin.locator(".dish", has_text="Chocolate Brownie")
    await tap("admin", dish.locator("label.switch"))
    await check("Brownie marked sold out", expect(admin.locator("#toast")).to_contain_text("sold out", timeout=10000))
    await check("Guest's order drops the sold-out dish",
                expect(guest.locator(".wa-msg.bot", has_text="just sold out")).to_be_visible(timeout=40000))
    await beat(2.2)
    await tap("admin", dish.locator("label.switch"))
    await check("Brownie back on the menu", expect(admin.locator("#toast")).to_contain_text("available", timeout=10000))
    await beat(0.8)

    # 4 · Serving order + place
    await stage("t=>window.__chapter(t)", "Step 2 · Guests order")
    await layout("guest")
    await cap("Guests choose what comes first", "Tea first, pizza after",
              "Your kitchen sees the same serving order on every ticket.")
    await tap("guest", guest.locator(".wa-cart-badge"))
    await expect(guest.locator(".wa-cart-card .wa-cart-row")).to_have_count(3, timeout=8000)
    for _ in range(2):
        await tap("guest", guest.locator('.wa-cart-card [aria-label="Move Masala Chai up"]'))
        await beat(0.6)
    await check("Masala Chai served first",
                expect(guest.locator(".wa-cart-card .wa-cart-row").first).to_contain_text("Masala Chai", timeout=5000))
    await type_in("guest", guest.locator('.wa-cart-card [aria-label="Instructions for Margherita Pizza"]'),
                  "Extra crispy please", delay=45)
    await beat(0.6)
    await tap("guest", guest.locator(".wa-cart-card button[data-order-submit]", has_text="Place order"))
    await check("Order placed", expect(guest.locator(".wa-order-card .wa-order-no").last).to_be_visible(timeout=20000))
    no = (await guest.locator(".wa-order-card .wa-order-no").last.inner_text()).replace("Order", "").strip()
    await beat(1.6)

    # 5 · Kitchen
    await stage("t=>window.__chapter(t)", "Step 3 · Kitchen")
    await layout("trio")
    await cap("Step 3 · Straight to the kitchen", "No paper slips. No lost orders.",
              "The ticket appears instantly with the guest's notes and serving order.")
    kcard = kitchen.locator(".card", has_text=no)
    await check("Kitchen receives the order", expect(kcard).to_be_visible(timeout=25000))
    await beat(2.0)
    await tap("guest", guest.locator(".wa-dock .wa-chip", has_text="Track Order"))
    await tap("kitchen", kcard.locator("button.b-advance-all", has_text=re.compile(r"^Accept all")))
    await beat(1.2)
    chai = kcard.locator(".item-row", has_text="Masala Chai")
    for label, pill in (("Start cooking", "Preparing"), ("Mark ready", "Ready"), ("Mark served", "Served")):
        await tap("kitchen", chai.locator("button.item-advance", has_text=label))
        await expect(chai).to_contain_text(pill, timeout=10000)
        await beat(0.7)
    await cap("Guests see every step", "Fewer \"where is my food?\" questions",
              "Each dish updates live on the guest's phone, from accepted to served.")
    await check("Guest sees the tea served",
                expect(guest.locator(".wa-status-card").last.locator(".wa-status-item", has_text="Masala Chai")
                       .locator(".wa-item-status")).to_have_text(re.compile("served", re.I), timeout=20000))
    await beat(1.2)
    for label in ("Start cooking all", "Mark ready all", "Mark served all"):
        await tap("kitchen", kcard.locator("button.b-advance-all", has_text=re.compile("^" + label)))
        await beat(1.1)
    await check("Ticket clears when everything is served", expect(kcard).to_have_count(0, timeout=20000))
    await beat(1.2)

    # 6 · Pay
    await stage("t=>window.__chapter(t)", "Step 4 · Payment")
    await layout("guest")
    await cap("Step 4 · Pay from the table", "Bill in one tap, UPI QR with the amount filled in",
              "No waiting for the bill folder. Works with GPay, PhonePe, Paytm and BHIM.")
    await tap("guest", guest.locator(".wa-dock .wa-chip", has_text="Get Bill"))
    await expect(guest.locator(".wa-bill table").last).to_be_visible(timeout=20000)
    await beat(1.6)
    await tap("guest", guest.locator("button.wa-btn", has_text="Pay bill").last)
    qr = guest.locator(".wa-pay-card .wa-qr").last
    await check("Payment QR shown", expect(qr.locator("img, canvas").first).to_be_attached(timeout=20000))
    await qr.scroll_into_view_if_needed()
    await beat(3.0)
    if HAVE_QR:
        got = decode_qr(await qr.screenshot())
        await check("Payment QR is a valid UPI link", _true(got and got[0].startswith("upi://pay?")))

    await layout("trio")
    await cap("You stay in control", "The manager confirms the payment",
              "The table closes automatically once it is served and paid.")
    bill = manager.locator(".bill", has_text=no)
    await expect(bill).to_be_visible(timeout=20000)
    await tap("manager", bill.locator("button.mark-paid"))
    await check("Guest told the table is closed",
                expect(guest.locator(".wa-msg.bot", has_text="bill has been paid")).to_be_visible(timeout=40000))
    await beat(2.2)

    # 7 · Reports: load off camera so viewers never see empty "—" tiles.
    await admin.goto("%s/reports.html?r=%s" % (BASE, SLUG))
    await check("Reports load", expect(admin.locator("#revenue")).not_to_have_text("—", timeout=30000))
    try:
        await expect(admin.locator("#revenueChart svg, #revenueChart .error").first).to_be_attached(timeout=15000)
    except Exception:
        pass
    await beat(1.0)
    # Chrome's screencast can stall after a background navigation and keep the
    # loading frame; restarting it forces a fresh frame of the loaded page.
    await STAGE["relay"].retarget("admin", admin, 1280)
    await admin.evaluate("()=>window.scrollBy(0,1)")
    await beat(0.8)
    await stage("t=>window.__chapter(t)", "Your numbers")
    await layout("admin")
    await cap("Know your numbers", "Sales, orders and best sellers, always up to date",
              "Every order is recorded automatically.")
    await beat(2.0)
    await smooth_scroll(admin, 520)
    await beat(2.2)

    await stage("t=>window.__chapter(t)", "")
    await layout("none")
    await card("", "Faster service.<br><em>Happier guests.</em>",
               "Upload your menu, print your table QR codes and start taking orders.",
               [["No app for guests", "They just scan the QR on the table"],
                ["Any device", "Kitchen and manager screens run in a browser"],
                ["Always in sync", "Guests, kitchen and manager see the same order live"]], secs=6.0, keep=True)


async def stage_still(name):
    try:
        await STAGE["page"].screenshot(path=os.path.join(OUT, name))
    except Exception:
        pass


async def restore_availability(actx):
    """Safety net: make sure no dish is left sold out by this run."""
    try:
        login = await actx.request.post(BASE + "/auth/login", data={"email": ADMIN[0], "password": ADMIN[1]})
        if not login.ok:
            return
        menu = await (await actx.request.get("%s/menu?restaurant=%s" % (BASE, SLUG))).json()
        for it in menu.get("items", []):
            if it.get("name") == "Cappuccino" and it.get("available") is False and it.get("id"):
                await actx.request.patch("%s/manager/menu/%s?restaurant=%s" % (BASE, it["id"], SLUG),
                                         data={"available": True})
                print("  restored Cappuccino availability", flush=True)
    except Exception:
        pass


def write_report(started):
    passed = sum(1 for r in RESULTS if r["ok"])
    total = len(RESULTS)
    secs = (datetime.now() - started).total_seconds()
    with open(os.path.join(OUT, "e2e-results%s.json" % SUFFIX), "w", encoding="utf-8") as f:
        json.dump({"base": BASE, "restaurant": SLUG, "started": started.isoformat(), "seconds": round(secs),
                   "passed": passed, "total": total, "results": RESULTS}, f, indent=2)
    lines = ["# DineOS end-to-end test report", "",
             "- Run: %s (%d s)" % (started.strftime("%Y-%m-%d %H:%M"), secs),
             "- Target: %s, restaurant `%s`, table `%s`" % (BASE, SLUG, TABLE),
             "- Result: **%d / %d checks passed**" % (passed, total),
             "- QR decoding: %s" % ("on (zxing-cpp)" if HAVE_QR else "off (zxing-cpp not installed)"),
             "- Video: `demo-recording/%s`" % os.path.basename(VIDEO), ""]
    chap = None
    for r in RESULTS:
        if r["chapter"] != chap:
            chap = r["chapter"]
            lines += ["", "## " + chap, "", "| | Check | Detail |", "|---|---|---|"]
        lines.append("| %s | %s | %s |" % ("✅" if r["ok"] else "❌", r["check"].replace("|", "/"),
                                          r["error"].replace("|", "/")))
    with open(os.path.join(OUT, "e2e-test-report%s.md" % SUFFIX), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n%d / %d checks passed in %d s" % (passed, total, secs), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0 if all(r["ok"] for r in RESULTS) else 1)

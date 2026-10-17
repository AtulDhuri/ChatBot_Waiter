"""Diagnose a PDF: how much text PyMuPDF extracts, per page, + image check.

Usage:  python diagnose_pdf.py "C:\\path\\to\\your_menu.pdf"
"""
import sys
import fitz  # PyMuPDF


def diagnose(path):
    print(f"\n=== {path} ===")
    doc = fitz.open(path)
    print(f"pages: {len(doc)}")
    total_text = 0
    for i, page in enumerate(doc):
        text = page.get_text("text") or ""
        imgs = page.get_images(full=True)
        total_text += len(text.strip())
        print(
            f"  page {i+1}: {len(text.strip())} chars of text, "
            f"{len(imgs)} embedded image(s)"
        )
        if text.strip():
            preview = " ".join(text.split())[:120]
            print(f"     preview: {preview!r}")
    doc.close()

    print(f"\n  TOTAL extractable text: {total_text} chars")
    if total_text < 10:
        print(
            "  VERDICT: image-based / scanned PDF (no text layer). "
            "PyMuPDF can't read text from it — this needs OCR."
        )
    else:
        print("  VERDICT: text-based PDF. PyMuPDF extracts it fine.")


if __name__ == "__main__":
    targets = sys.argv[1:] or ["sample_menu.pdf", "seaside_menu.pdf"]
    for t in targets:
        try:
            diagnose(t)
        except Exception as e:
            print(f"  ERROR opening {t}: {e}")

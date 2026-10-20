import asyncio
from sqlalchemy import text
from app.db.database import session_scope


async def main():
    async with session_scope() as s:
        rows = (
            await s.execute(
                text(
                    "SELECT r.id, r.slug, r.name, count(m.id) AS items "
                    "FROM restaurants r "
                    "LEFT JOIN menu_items m ON m.restaurant_id = r.id "
                    "GROUP BY r.id, r.slug, r.name ORDER BY r.id"
                )
            )
        ).mappings().all()
        if not rows:
            print("NO RESTAURANTS in the database yet.")
            return
        print("id | slug | name | menu_items")
        for r in rows:
            print(f"  {r['id']} | {r['slug']!r} | {r['name']!r} | {r['items']}")


asyncio.run(main())

"""Generate sample restaurant menu PDFs for testing the ingest pipeline.

Usage:
    python make_sample_menu.py            -> writes sample_menu.pdf (Demo Bistro)
    python make_sample_menu.py seaside    -> writes seaside_menu.pdf (Seaside Grill)
"""
import sys

import fitz

MENUS = {
    "demo": (
        "sample_menu.pdf",
        """DEMO BISTRO MENU

STARTERS
Bruschetta - Toasted bread, tomato, basil .... 6.50
Garlic Bread - With mozzarella .... 5.00
Soup of the Day .... 5.50

MAINS
Margherita Pizza - Tomato, mozzarella, basil .... 12.50
Pepperoni Pizza - Spicy pepperoni, cheese .... 14.00
Spaghetti Carbonara - Pancetta, egg, parmesan .... 13.50
Grilled Salmon - With seasonal vegetables .... 18.00
Veggie Burger - Plant-based patty, fries .... 11.50

DESSERTS
Tiramisu .... 6.00
Chocolate Lava Cake .... 6.50
Gelato (3 scoops) .... 4.50

DRINKS
Cola .... 3.00
Fresh Orange Juice .... 4.00
House Red Wine (glass) .... 7.00
Espresso .... 2.50
""",
    ),
    "seaside": (
        "seaside_menu.pdf",
        """SEASIDE GRILL MENU

SMALL PLATES
Oysters (half dozen) .... 14.00
Calamari - Crispy, lemon aioli .... 10.50
Clam Chowder .... 8.00

FROM THE SEA
Fish and Chips - Beer-battered cod .... 16.50
Grilled Octopus - Smoked paprika .... 19.00
Lobster Roll - Buttered brioche .... 24.00
Seared Tuna - Sesame crust .... 22.50

LAND
Ribeye Steak - 300g, chimichurri .... 28.00
Grilled Chicken - Herb marinade .... 17.00

SWEETS
Key Lime Pie .... 7.50
Salted Caramel Cheesecake .... 8.00

DRINKS
Sparkling Water .... 3.50
Craft Lager .... 6.50
White Wine (glass) .... 8.00
""",
    ),
}

key = sys.argv[1] if len(sys.argv) > 1 else "demo"
key = "seaside" if key.startswith("sea") else "demo"
filename, text = MENUS[key]

doc = fitz.open()
page = doc.new_page()
page.insert_text((50, 60), text, fontsize=11, fontname="helv")
doc.save(filename)
doc.close()
print("Wrote", filename)

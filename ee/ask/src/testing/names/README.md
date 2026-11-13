# Name list used by the common-word tests

`census-2010-surnames.txt` holds the surnames of the US Census Bureau's "Frequently Occurring Surnames from the 2010 Census" (surnames held by at least 100 people), lowercased, one per line, sorted, with the row "all other names" dropped: 162,253 names.

- Publisher: US Census Bureau, a US federal statistical product.
- Source file: `Names_2010Census.csv` in `https://www2.census.gov/topics/genealogy/2010surnames/names.zip`, downloaded 2026-11-13 (archive sha-256 `117c41cb4668727b7627b2845b6df3f83eb2a22a1813f42c0ff4bdcab86de135`).
- Terms: the Bureau's page on citing its data asks that the Census Bureau be named as the source; no other licence text was found on the file's pages.
- Use: test data only, to prove that no word of the common-word list is a surname. It is not built into the package and not shipped.

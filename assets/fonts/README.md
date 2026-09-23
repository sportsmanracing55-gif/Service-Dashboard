# Corporate font

The dashboard is set in **Mazda Type**, Mazda's corporate typeface. It is licensed
to Mazda and its dealer network and cannot be redistributed here, so this folder is
empty on purpose.

Copy the font files from the brand guide / dealer marketing portal into this folder
with these names (WOFF2 preferred, WOFF also picked up):

| File | Weight |
|---|---|
| `MazdaType-Regular.woff2` | 400 |
| `MazdaType-Medium.woff2` | 500 |
| `MazdaType-Bold.woff2` | 700 |

If your files have different names, edit the `@font-face` blocks at the top of
`css/styles.css`. Until the files are present the dashboard falls back to
Helvetica Neue / Arial automatically.

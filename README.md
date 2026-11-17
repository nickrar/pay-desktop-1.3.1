# Pay. — Desktop App (Electron)

Personal Finance & Daily Earning Tracker, packaged as a desktop app.
Everything (styles + fonts) is bundled locally, so it works offline.
Only the live currency rates need internet; without it the app uses built-in fallback rates.

## Requirements
- Node.js 18 or newer (LTS recommended): https://nodejs.org

## Run it
Open a terminal in this folder and run:

```bash
npm install
npm start
```

The window opens maximized. Press **F11** (Windows/Linux) or **Ctrl+Cmd+F** (macOS) for true full screen.
Press **Alt** to show the menu bar (View → Reload, Zoom, Toggle Full Screen).

## Build an installer (optional)
Build on the same system you want the installer for:

```bash
npm run dist:win     # Windows  -> release/Pay Setup x.y.z.exe + portable .exe
npm run dist:mac     # macOS    -> release/Pay-x.y.z.dmg
npm run dist:linux   # Linux    -> release/Pay-x.y.z.AppImage
```

## Editing the page
- The app page is `app/index.html`.
- Styles are compiled from `src/input.css` + `tailwind.config.js` into `app/styles.css`.
  If you add or change CSS classes in `app/index.html`, rebuild the styles:

```bash
npm run build:css
```

## Your data
Entries are saved automatically on your computer (inside the app's own storage).
Use the download icon (bottom of the left sidebar) to export a JSON backup.
Settings (avatar menu) also has **Import JSON Backup** and **Download Safety Backup**.
The app keeps a safety copy automatically before upgrading old data, importing,
loading sample data, or clearing everything.

## Money logic
All calculations live in `app/finance-engine.js`, shared by every screen.
See `FIXES.md` for the rules and what changed in 1.3.0.

## Run the checks
```bash
npm test
```
Uses Node's built-in test runner on throwaway data — it never touches your saved entries.

## Folder layout
```
main.js              Electron window + menu
package.json         Scripts and installer settings
app/index.html       The app (screens)
app/finance-engine.js  All money calculations (cash, net worth, budgets, debts, rollover)
tests/               Automated checks for the money logic
FIXES.md             What was wrong and what changed in 1.3.0
app/styles.css       Compiled styles
app/fonts/           Bundled fonts (Inter, Plus Jakarta Sans)
src/input.css        Style source
tailwind.config.js   Colors, fonts, shadows
build/icon.png       App icon
```

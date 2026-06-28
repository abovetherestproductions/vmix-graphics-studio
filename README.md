# vMix HTML Graphics Starter

This is a starter project for building browser-based broadcast graphics for vMix.

The first included template is a 1920x1080 dynamic starting-order graphic that:

- runs in the vMix Web Browser input
- uses a transparent background
- polls JSON every 500ms
- dynamically renders only the rows present in the JSON
- supports large / standard / compact row layouts
- supports animate in, update, and animate out behavior

## Install

```powershell
npm install
npm run dev
```

Open this in a browser:

```text
http://127.0.0.1:3012/graphics/starting-order/
```

In vMix, add a **Web Browser** input using that same URL.

## Test JSON changes

In another terminal:

```powershell
node tools/write-sample-starting-order.js three
node tools/write-sample-starting-order.js seven
node tools/write-sample-starting-order.js hidden
```

The browser graphic should update automatically.

## Current payload

The graphic reads:

```text
/public/data/starting-order.json
```

The intended flow is:

```text
Raw data feed -> normalizer/adapter -> graphics-ready JSON -> browser graphic in vMix
```

## vMix usage

Recommended workflow:

1. Keep the browser input loaded.
2. Update JSON/control state.
3. Put the browser input on overlay in vMix.
4. Trigger visible=true / animateIn.
5. For removal, trigger visible=false / animateOut.
6. After the out animation finishes, remove the vMix overlay.

For a first test, simply add the browser input and edit the JSON file.

## Repairing recording filenames

The recording repair utility is a conservative fallback for files that were
named with stale metadata. It only previews changes unless `--apply` is added.

Match files to the recording action log:

```powershell
npm run recordings:repair -- --folder "C:\SkatingVideos\_Needs Review"
```

When the action log also contains stale names, use a saved Skate Canada
start-order CSV. Files are matched chronologically, and the tool refuses to
apply anything unless the file and start-order counts match:

```powershell
npm run recordings:repair -- --folder "C:\SkatingVideos\_Needs Review\Pre-Novice Women" --start-order "C:\path\SC2_csslivetextStartOrder.csv" --segment "Pre-Novice Women - Free Program"
```

Review the proposed mapping, then repeat the command with `--apply`. Log
matches more than ten minutes apart are held for manual review unless
`--include-low` is explicitly supplied.

The Production Control page also has a **Recording Filename Repair** panel.
**Scan Needs Review** creates a server-side preview from the configured folder
and action log. **Apply Proposed Renames** stays disabled until that scan finds
eligible changes, and the proposal is rejected if any involved file changes
before it is applied.

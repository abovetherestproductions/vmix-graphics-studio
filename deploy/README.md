# Deploying vMix Graphics Studio to a production machine

Everything an operator's vMix machine needs, in one pass: Node.js, Git, the
graphics studio itself, and a Windows service so it is running before anyone
logs in.

---

## Before you send this to anyone (studio checklist)

**1. Create a read-only access token.** The repo is private, so each machine
needs credentials to download updates.

- Go to <https://github.com/settings/personal-access-tokens>
- **Fine-grained token** → *Only select repositories* → this repo
- Permissions → **Contents: Read-only**
- Set an expiry you will actually remember. When it expires, Check & Update
  stops working on every machine until you issue a new one.

Read-only means an operator can pull your updates but can never push anything
back. Send the token to them over something private — not email.

**2. Decide what ships.** Anything committed to the repo lands on every machine
you deploy to, including git history. Event spreadsheets with skater and coach
names should live in `uploads/` (already git-ignored), not in the repo.

---

## Installing on the vMix machine

1. Copy the `deploy` folder onto the machine (USB stick or download).
2. Right-click **`Install-VmixGraphics.ps1`** → **Run with PowerShell**.
3. Accept the Windows permission prompt.
4. Paste the access token when asked. The typing is hidden. It goes straight
   into Windows Credential Manager — it is never written into a file.

The installer will:

- install **Git** and **Node.js LTS** with `winget` (skipping either if present)
- clone the studio to `C:\vMixGraphics`
- run `npm ci`
- register the **VmixGraphicsStudio** Windows service (auto-start at boot)
- put two shortcuts on the desktop
- open the operator page to confirm it works

Takes about five minutes on a clean machine, mostly downloads.

### If the machine has no `winget`

`winget` ships with Windows 10 21H1 and later. On something older, install
**App Installer** from the Microsoft Store and run the script again.

---

## Day to day

| Desktop shortcut | What it does |
|---|---|
| **vMix Graphics Studio** | Opens the operator page (`http://localhost:3012/operator/`) |
| **Force Start Graphics** | Restarts everything when the page will not load |

The service starts automatically at boot. Operators should not need to touch
anything.

### "The page won't load"

Double-click **Force Start Graphics**. It stops the service, clears anything
stuck on port 3012, starts it again, and confirms the server is answering.

If the service still will not start, it falls back to running the server in a
visible window so the error is on screen — that window's text is what to send
back to the studio. Leaving that window open keeps the graphics running.

---

## Sending an update

From your studio: commit, push. On the operator's machine: **Tools → Check &
Update**.

Because the server runs under the service wrapper, it pulls the new code, exits,
and Windows restarts it automatically. The operator page waits for it to come
back and reloads itself. No manual restart, nothing for the operator to
remember.

**Their settings are not touched.** Config is layered:

| File | Tracked? | Holds |
|---|---|---|
| `style-defaults.json` | **yes** | Your studio's look. Ships with updates. |
| `style-config.json` | no | Only what *that machine* changed from your defaults |
| `event-state.json` | no | Their event selection and workbook paths |
| `uploads/` | no | Their spreadsheets |

Nothing on their machine writes to the tracked file, which is what keeps
`git pull --ff-only` working forever. A setting they never touched keeps
inheriting your new defaults; one they did change survives the update.

---

## Migrating a machine that ran an older build

A machine that predates the layered config has `event-config.json` **tracked**,
and the server rewrites it constantly — so its first pull will fail with
*"local changes would be overwritten"*. One time only, on that machine:

```powershell
cd C:\vMixGraphics
copy public\data\event-config.json "$env:USERPROFILE\Desktop\event-config-backup.json"
git checkout -- public/data/event-config.json
git pull --ff-only
copy "$env:USERPROFILE\Desktop\event-config-backup.json" public\data\event-config.json
```

Then restart the service. On boot the server splits that file into the new
layout and the machine keeps its event selection, workbook paths, and settings.
Every update after this one is clean.

Do this between events, not during one.

---

## Reference

**Paths**

```
C:\vMixGraphics\                     the studio
C:\vMixGraphics\logs\                service logs (start here when debugging)
C:\vMixGraphics\uploads\             operator's spreadsheets
C:\vMixGraphics\public\data\         config
```

**Service commands** (Administrator PowerShell)

```powershell
Get-Service VmixGraphicsStudio          # is it running?
Restart-Service VmixGraphicsStudio
Get-Content C:\vMixGraphics\logs\VmixGraphicsStudio.err.log -Tail 40
```

**Removing it**

```powershell
cd C:\vMixGraphics\service
.\VmixGraphicsStudio.exe stop
.\VmixGraphicsStudio.exe uninstall
```

Then delete `C:\vMixGraphics`. To also clear the saved token, remove the
`github.com` entry from *Windows Credential Manager → Windows Credentials*.

**Another machine on the network needs to reach the graphics**

The installer does not open the firewall, since vMix normally reads the
graphics from the same machine over `localhost`. To control the studio from a
tablet or a second PC, allow the port explicitly:

```powershell
New-NetFirewallRule -DisplayName "vMix Graphics Studio" -Direction Inbound `
  -Protocol TCP -LocalPort 3012 -Action Allow -Profile Private
```

Only do this on a trusted production network — it exposes the control pages to
anyone who can reach the machine.

# cmd-mod-status-bar

> Clean, responsive status bar footer with live limits, compaction-aware context, and workspace tab titling for [Command Code](https://commandcode.ai).

![Status Bar Preview](https://raw.githubusercontent.com/Sandeep2062/cmd-mod-status-bar/main/assets/preview.png)

```text
PixVault (main) · deepseek-v4.1-flash (high) · ctx 95k/1M · 9% · 5h: 1% (4h 47m) · wk: 10% (6d 3h)
```

---

## ✨ Features

- **🔄 Real-Time Rolling Limits & Reset Countdowns**: Displays live 5-hour rolling usage (`5h: X% (4h 47m)`) and weekly quota (`wk: X% (6d 3h)`) polled directly from the Command Code billing API.
- **🧠 Compaction-Aware Context Usage**: Shows active context window utilization (`ctx 95k/1M · 9%`). Seamlessly accounts for `/compact` reductions so token counts never get stuck on stale pre-compaction sizes.
- **🏷 Smart Multi-Session Tab Titling**: Automatically names your terminal tabs after your repository or folder (e.g. `PixVault`). If multiple sessions open the same project, tabs are sequentially numbered (`PixVault`, `PixVault (2)`) and cleaned up automatically when closed.
- **📱 Responsive Layout (Single & Multi-line)**: Automatically expands to a single line on wide terminals, cleanly splitting into a two-line layout on narrower or split panes without text truncation.
- **⚡ Zero Dependencies**: Pure standard Node.js (`https`, `fs`, `path`) using Command Code's native `ModApi`. No heavy dependencies or build steps.

---

## 🚀 Installation

### Via Command Code Mods CLI (Global)

```bash
cmd mods add cmd-mod-status-bar -g
```

### From Local Source

Clone or place the repository in your projects directory:

```bash
git clone https://github.com/Sandeep2062/cmd-mod-status-bar.git
cmd mods add ./cmd-mod-status-bar -g
```

---

## 🛠 Recommended Settings

For the cleanest minimalist experience, disable Command Code's default statusline items in `~/.commandcode/settings.json` so `cmd-mod-status-bar` serves as your unified status footer:

```json
{
  "statusline": {
    "enabled": false
  }
}
```

---

## 🔍 Inspection & Verification

Verify that the mod is discovered and healthy:

```bash
cmd mods list
```

Inspect registered hooks and capabilities without executing:

```bash
cmd mods inspect cmd-mod-status-bar
```

Expected output:
```text
files:     1
hooks:     onTurnStart, onTurnEnd, onRunEnd
registers: event subscription, widget
reaches:   network (fetch / http / net), filesystem (fs), environment (process.env)
imports:   https, fs, path
```

---

## 🌐 Listing on Command Code Mods Hub

To list on the public [Command Code Mods Hub](https://commandcode.ai/mods):

1. Publish to npm:
   ```bash
   npm publish --access public
   ```
2. Submit a PR to [`CommandCodeAI/command-code`](https://github.com/CommandCodeAI/command-code) adding an entry to `mods/registry.json`:

```json
{
  "name": "status-bar",
  "source": "cmd-mod-status-bar",
  "description": "Clean responsive status bar footer with live limits, compaction-aware context, and workspace tab titling.",
  "author": {
    "name": "Sandeep Khadka",
    "github": "Sandeep2062"
  },
  "repo": "https://github.com/Sandeep2062/cmd-mod-status-bar",
  "npm": "cmd-mod-status-bar",
  "kinds": ["hook"],
  "tags": ["status-bar", "footer", "usage", "context", "tabs"]
}
```

---

## 📄 License

MIT © [Sandeep Khadka](https://github.com/Sandeep2062)

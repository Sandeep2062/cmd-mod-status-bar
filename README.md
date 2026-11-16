# cmd-mod-status-bar

Status bar footer with live limits, compaction-aware context, and workspace tab titling for [Command Code](https://commandcode.ai).

```text
PixVault (main) · deepseek-v4.1-flash (high) · ctx 95k/1M · 9% · 5h: 1% (4h 47m) · wk: 10% (6d 3h)
```

## Features

- **Rolling Limits**: Displays 5-hour and weekly usage percentages and reset countdowns fetched directly from the Command Code billing API.
- **Compaction-Aware Context**: Tracks active token usage against context limits, automatically accounting for `/compact` reductions without stale token counts.
- **Dynamic Model Tracking**: Automatically displays current active model and reasoning effort.
- **Workspace Tab Titling**: Sets terminal tab titles to the workspace git repository name, with sequential numbering for duplicate sessions (`PixVault`, `PixVault (2)`). Dead session PIDs are automatically cleaned up on exit.
- **Responsive Layout**: Renders on a single line on wide terminals, cleanly wrapping to two lines on split screens without text clipping.
- **Zero Dependencies**: Pure standard Node.js runtime (`https`, `fs`, `path`).

## Installation

### Via Command Code Mods CLI

```bash
cmd mods add Sandeep2062/cmd-mod-status-bar -g
```

Or from local checkout:

```bash
cmd mods add ./cmd-mod-status-bar -g
```

## Recommended Configuration

To use `cmd-mod-status-bar` as your unified status footer without duplicate built-in status items, disable default statusline items in `~/.commandcode/settings.json`:

```json
{
  "statusline": {
    "enabled": false
  }
}
```

## Verification

Check that the mod is loaded:

```bash
cmd mods list
```

Inspect registered hooks and capabilities:

```bash
cmd mods inspect cmd-mod-status-bar
```

## Mods Hub Registry Entry

To register in `CommandCodeAI/command-code` under `mods/registry.json`:

```json
{
  "name": "status-bar",
  "source": "Sandeep2062/cmd-mod-status-bar",
  "description": "Responsive status bar footer with live limits, compaction-aware context, and workspace tab titling.",
  "author": {
    "name": "Sandeep Khadka",
    "github": "Sandeep2062"
  },
  "repo": "https://github.com/Sandeep2062/cmd-mod-status-bar",
  "kinds": ["hook"],
  "tags": ["status-bar", "footer", "usage", "context", "tabs"]
}
```

## License

MIT © [Sandeep Khadka](https://github.com/Sandeep2062)

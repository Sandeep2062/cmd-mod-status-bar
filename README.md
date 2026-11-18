# cmd-mod-status-bar

Status bar footer with live limits, compaction-aware context, workspace tab titling, and screen keep-awake for [Command Code](https://commandcode.ai).

```text
PixVault (main) · deepseek-v4.1-flash (high) · ctx 95k/1M · 9% · 5h: 1% (4h 47m) · wk: 10% (6d 3h)
```

## Features

- **Rolling Limits**: Displays 5-hour and weekly usage percentages and reset countdowns fetched directly from the Command Code billing API.
- **Accurate Context Tracking**: Mirrors Command Code's `/context` breakdown — estimated conversation messages, memory files (`AGENTS.md` layers), built-in tools, and loaded skills. Messages are normalized exactly like the harness: tool results keep only their text, images are sized by dimensions, so embedded screenshots never inflate the count. Compaction-aware reconstruction keeps the estimate correct on resumed sessions and after `/compact`.
- **Dynamic Model Tracking**: Automatically displays current active model and reasoning effort.
- **Screen & Laptop Keep-Awake**: Automatically prevents your laptop from sleeping and keeps the screen awake while Command Code is actively running or thinking (using native Windows `SetThreadExecutionState`, macOS `caffeinate`, or Linux `systemd-inhibit`), cleanly releasing sleep locks when idle.
- **Workspace Tab Titling**: Sets terminal tab titles to the workspace git repository name, with sequential numbering for duplicate sessions (`PixVault`, `PixVault (2)`). Dead session PIDs are automatically cleaned up on exit.
- **Pure Observer Pattern**: Uses safe `cmd.on` lifecycle events with zero state mutations or risky hooks.
- **Responsive Layout**: Renders on a single line on wide terminals, cleanly wrapping to two lines on split screens without text clipping.
- **Zero Dependencies**: Pure standard Node.js runtime (`https`, `fs`, `path`, `child_process`).

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

## License

MIT © [Sandeep Khadka](https://github.com/Sandeep2062)

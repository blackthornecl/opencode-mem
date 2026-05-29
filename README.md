# opencode-mem

Persistent memory plugin for [OpenCode](https://opencode.ai) - captures tool usage and injects context into future sessions.

Based on [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman.

## Features

- **Automatic Observation Capture** - Captures every tool execution and assistant message
- **Persistent Memory** - Observations are stored in a local database
- **Memory Search** - Query your project history with `claude_mem_search` tool
- **Session Summaries** - Automatic summarization when sessions go idle

## Prerequisites

**claude-mem must be installed and running before using this plugin.**

```bash
# Install claude-mem globally
npm install -g claude-mem

# Start the worker
npx claude-mem start
```

The plugin sends observations to claude-mem's worker (port 37700). Without it, observations cannot be stored.

## Install Plugin

```bash
# Copy plugin to OpenCode plugins directory
mkdir -p ~/.config/opencode/plugins
cp plugin/index.js ~/.config/opencode/plugins/opencode-mem.js

# Register plugin in OpenCode config
# Add to ~/.config/opencode/opencode.json:
# {
#   "plugin": ["./plugins/opencode-mem.js"]
# }
```

Or use the install script:
```bash
npm run install-plugin
```

### Register in Config

Create or edit `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["./plugins/opencode-mem.js"]
}
```

## Usage

1. Start the claude-mem worker:
   ```bash
   npx claude-mem start
   ```

2. Restart OpenCode to load the plugin

3. Use OpenCode normally - observations are captured automatically

4. Search your memory with the `claude_mem_search` tool:
   ```
   claude_mem_search(query="authentication bug")
   ```

## Configuration

The plugin uses the same configuration as claude-mem:

- `CLAUDE_MEM_WORKER_PORT` - Worker port (default: 37700)
- Settings file: `~/.claude-mem/settings.json`

## How It Works

1. **Plugin loads** when OpenCode starts
2. **Tool executions** are captured via `tool.execute.after` hook
3. **Assistant messages** are captured via `chat.message` hook
4. **Observations** are sent to the claude-mem worker
5. **Search** queries the worker's observation database

## License

Licensed under the Apache License, Version 2.0

This project is based on [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman, licensed under Apache 2.0.

### Attribution

This software includes material from claude-mem:
- Repository: https://github.com/thedotmack/claude-mem
- Author: Alex Newman (@thedotmack)
- License: Apache License 2.0

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a Pull Request

## Support

- **Issues**: GitHub Issues
- **Based on**: [claude-mem](https://github.com/thedotmack/claude-mem)
- **OpenCode**: [opencode.ai](https://opencode.ai)

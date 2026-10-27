# whatsapp-cli

A small terminal WhatsApp client built on [Baileys](https://github.com/WhiskeySockets/Baileys) (the WhatsApp Web multi-device protocol).

## Install

You need [Node.js](https://nodejs.org/) 20 or newer (`node -v` to check) and git.

    git clone https://github.com/caimazo/whatsapp-cli.git
    cd whatsapp-cli
    npm install

Optionally, put a `wa-cli` command on your PATH:

    npm link

`npm link` symlinks to this folder, so the session and chat store stay in `./data` here. Run `npm unlink -g whatsapp-cli` to remove the command.

## Run

    npm start        # or: wa-cli

On first run, scan the QR code with your phone (WhatsApp → Settings → Linked devices → Link a device).
The session is saved in `./data/auth`, so later runs reconnect without a QR code.

To update later: `git pull && npm install`.

## Commands

| Command | |
|---|---|
| `/chats [filter]` | list recent chats, numbered |
| `/open <n\|name>` | open a chat |
| `/new <phone>` | start a chat with a number, international format (`447700900123`) |
| `/history [n]` | show last n messages of the open chat |
| `/close` | close the current chat |
| `/logout` | unlink this device and delete the session |
| `/quit` | exit |

Any other text is sent to the open chat. Messages for other chats appear as `● Name: text` notifications.

## Notes

- Text only for sending. Incoming media shows as placeholders like `[image] caption`.
- Chat history comes from WhatsApp's initial sync after linking, plus whatever arrives while the app runs (up to 200 messages per chat, kept in `./data/store.json`).
- Environment: `WA_DATA_DIR` changes the data folder, and `WA_LOG_LEVEL=debug` turns on Baileys logs. Without it, libsignal's console chatter (`Closing session: SessionEntry {...}` and so on) is hidden.
- This is an **unofficial** client. WhatsApp's terms don't allow unofficial clients, and accounts can be banned for them, especially for bulk or automated messaging. For personal tinkering the risk is low, but it isn't zero.

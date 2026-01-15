# PvP Scalpel Launcher

PvP Scalpel Launcher is a lightweight, secure desktop launcher and patcher built with **Tauri v2, React, and TypeScript**. It is the single entry point for the PvP Scalpel ecosystem and is responsible for keeping the desktop application and the World of Warcraft addon fully synchronized.

The launcher ensures that users always run compatible versions of both components, handling updates automatically and transparently.

---

## Features

* Automatic desktop application version checking
* Automatic World of Warcraft addon version checking
* Silent desktop application updates via installer
* Automatic addon download and injection into the WoW AddOns folder
* Single manifest-based update system
* Lightweight native shell powered by Tauri
* Clean and minimal launcher UI

---

## Architecture Overview

The launcher is the **authoritative controller** of the PvP Scalpel ecosystem.

Flow:

1. Launcher starts
2. Reads installed desktop version from the system
3. Reads installed addon version from the `.toc` file
4. Fetches the latest versions from a remote manifest
5. Applies updates if mismatches are detected
6. Launches the desktop application when everything is in sync

The launcher itself is not updated by the addon or desktop app. All updates flow through the launcher.

---

## Components Managed

### Desktop Application

* Installed via NSIS installer
* Version tracked through Windows registry
* Updated silently when required

### World of Warcraft Addon

* Version read from `PvPScalpel.toc`
* Distributed as a ZIP archive
* Automatically extracted into the WoW `Interface/AddOns` directory

---

## Tech Stack

* **Tauri v2** (Rust backend)
* **React** (UI)
* **TypeScript**
* **Vite**
* **NSIS** (Windows installer)

---

## Development

### Prerequisites

* Node.js 18+
* Rust (stable)
* Windows build tools (on Windows)

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run tauri dev
```

This will:

* start the frontend dev server
* launch the Tauri shell
* load the app in development mode

---

## Build

To build the production installer:

```bash
npm run tauri build
```

The installer will be generated in:

```
src-tauri/target/release/bundle/
```

---

## Security Notes

* All downloads should be verified using checksums
* Installers are executed only after validation
* Updates are applied atomically to avoid partial states
* The launcher locks itself during update operations

---

## Versioning Strategy

* Desktop version is read from the system uninstall registry
* Addon version is read from the `.toc` file
* Remote versions are provided by a single manifest JSON
* Version mismatches always trigger an update

The launcher is the source of truth.

---

## License

This project is currently distributed under a proprietary license.

All rights reserved.

---

## Author

Developed by **Lychezar Stanev**
© 2026 PvP Scalpel

---

## Notes

This repository contains only the launcher logic. The desktop application and World of Warcraft addon are maintained as separate projects and distributed through the launcher.

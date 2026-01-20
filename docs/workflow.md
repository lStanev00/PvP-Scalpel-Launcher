# Launcher Workflow

This document describes the **runtime workflow**, **state resolution**, and the **exact log order** expected in the PvP Scalpel launcher.

The launcher is a **deterministic integrity gate**, not a passive installer. All UI decisions must be explainable via logs.

---

## 1) Initialization

**Goal:** Bring the launcher into a known baseline state.

**Actions**

* Initialize launcher runtime
* Prepare in-memory state containers

**Logs**

```
Launcher initialized
```

---

## 2) Path Detection (Read-only)

**Goal:** Discover required filesystem locations.

**Actions**

* Detect World of Warcraft install path (Addon root)
* Detect Desktop application install path

**Rules**

* Detection is read-only
* Detection must always resolve (found / not found)

**Logs**

```
WoW path detected
WoW path not found
Desktop path detected
Desktop path not found
```

---

## 3) Local Version Detection (Read-only)

**Goal:** Identify locally installed versions.

**Actions**

* Read Desktop app version from registry
* Read Addon version from `.toc`

**Rules**

* Missing path ⇒ version not found
* Detection must never mutate state

**Logs**

```
Desktop version detected (x.y.z)
Desktop version not found
Addon version detected (x.y.z)
Addon version not found
```

---

## 4) Manifest Fetch

**Goal:** Obtain authoritative target versions.

**Actions**

* Fetch manifest from API
* Cache manifest in memory after first load

**Rules**

* Manifest is read-only
* Manifest fetch must not block UI indefinitely

**Logs**

```
Manifest fetched
Manifest fetched (cache)
```

---

## 5) Version Comparison

**Goal:** Compare local versions against manifest targets.

**Actions**

* Compare Desktop local vs target
* Compare Addon local vs target

**Logs**

```
Desktop version OK
Desktop version mismatch
Addon version OK
Addon version mismatch
```

---

## 6) Resolve Component States (Terminal)

**Goal:** Convert raw facts into **terminal component states**.

**Desktop States**

* `INSTALLED_OK`
* `NOT_INSTALLED`
* `UPDATE_REQUIRED`
* `ERROR` (real failures only)

**Addon States**

* `INSTALLED_OK`
* `NOT_INSTALLED`
* `UPDATE_REQUIRED`
* `ERROR`

**Rules**

* Resolution is pure logic
* No IO or UI side effects

**Logs**

```
Desktop state resolved: INSTALLED_OK
Addon state resolved: UPDATE_REQUIRED
```

---

## 7) Resolve Global Launcher State

**Goal:** Derive a single authoritative launcher state.

**Launcher States**

* `READY` – all components INSTALLED_OK
* `BLOCKED` – any NOT_INSTALLED or UPDATE_REQUIRED
* `ERROR` – any component ERROR
* `UPDATING` – only during active installs/updates

**Logs**

```
Launcher state resolved: BLOCKED
```

---

## 8) Decide Required User Action

**Goal:** Determine the **only valid next action**.

**Priority Order**

1. Desktop NOT_INSTALLED → INSTALL_DESKTOP
2. Desktop UPDATE_REQUIRED → UPDATE_DESKTOP
3. Addon NOT_INSTALLED → INSTALL_ADDON
4. Addon UPDATE_REQUIRED → UPDATE_ADDON
5. READY → LAUNCH

**Logs**

```
Required action: INSTALL_DESKTOP
```

---

## 9) Idle State (Truthful UI)

**Goal:** Wait for user input without misleading visuals.

**Rules**

* No progress bar
* No “checking” or “updating” labels
* UI reflects resolved state only

**Logs**

```
Launcher idle, awaiting user action
```

---

## 10) Install / Update Execution (Mutation Phase)

**Goal:** Mutate the system safely.

**Flow**

1. User triggers required action
2. Preconditions validated
3. Operation starts
4. Progress streamed
5. Operation completes
6. Full re-detection (Steps 3 → 7)

**Logs**

```
Install started: Desktop
Download progress: 100%
Install completed
Rechecking integrity
```

**Rule**

* Never assume success
* Always re-run detection

---

## 11) Launch Execution (Guarded)

**Goal:** Launch only when integrity is VERIFIED.

**Rules**

* Launch allowed only if Launcher State = READY
* Final integrity check is mandatory

**Logs**

```
Launch requested
Final integrity OK
Desktop app launched
```

If launch fails:

* Component state → ERROR
* Launcher state → ERROR

---

## 12) Full Example Log Flow (Desktop Missing)

```
Launcher initialized
WoW path detected
Desktop path not found
Addon version detected (0.0.5)
Manifest fetched (cache)
Desktop state resolved: NOT_INSTALLED
Addon state resolved: INSTALLED_OK
Launcher state resolved: BLOCKED
Required action: INSTALL_DESKTOP
Launcher idle, awaiting user action
```

---

## 13) Full Example Log Flow (After Install)

```
Install started: Desktop
Download progress: 100%
Install completed
Rechecking integrity
Desktop state resolved: INSTALLED_OK
Addon state resolved: INSTALLED_OK
Launcher state resolved: READY
Required action: LAUNCH
```

---

## Core Principles (Lock These In)

* Detection ≠ Updating
* Transitional states must terminate
* Logs explain UI
* UI never contradicts logs
* Resolver is the single source of truth

This workflow is **final, deterministic, and production-grade**.

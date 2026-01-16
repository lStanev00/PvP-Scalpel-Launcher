import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Health = "ok" | "updating" | "error";

export type LauncherStatus = {
    desktop: { state: Health; version: string; target: string };
    addon: { state: Health; version: string; target: string };
    integrity: { state: Health; label: string };
    environment: { wowPath: string; desktopPath: string };
    progress: {
        active: boolean;
        percent: number;
        label: string;
        detail: string;
        rate: string;
    };
    canLaunch: boolean;
    primaryLabel: string;
};

export type LauncherActions = {
    startUpdate: () => void;
    cancelUpdate: () => void;
    launch: () => Promise<boolean>;
    forceRecheck: () => void;
    addLog: (line: string) => void;
    logs: string[];
};
type ManifestItem = { path: string; version: string };
type Manifest = {
    addon?: ManifestItem;
    desktop?: ManifestItem;
    launcher?: ManifestItem;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

const ts = () => {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export function useLauncherState(): { status: LauncherStatus; actions: LauncherActions } {
    const [logs, setLogs] = useState<string[]>([
        `[${ts()}] Launcher initialized`,
        `[${ts()}] Loaded local manifest`,
    ]);

    const [desktopState, setDesktopState] = useState<Health>("ok");
    const [addonState, setAddonState] = useState<Health>("updating");
    const [integrityState, setIntegrityState] = useState<Health>("ok");

    const [percent, setPercent] = useState(63);
    const [progressActive, setProgressActive] = useState(true);
    const [wowPath, setWowPath] = useState("Detecting...");
    const [desktopPath, setDesktopPath] = useState("Detecting...");
    const [desktopVersion, setDesktopVersion] = useState("Detecting...");
    const [addonVersion, setAddonVersion] = useState("Detecting...");
    const [desktopTarget, setDesktopTarget] = useState("Detecting...");
    const [addonTarget, setAddonTarget] = useState("Detecting...");

    const addLog = (line: string) => setLogs((p) => [`[${ts()}] ${line}`, ...p].slice(0, 250));

    const startUpdate = () => {
        setProgressActive(true);
        setAddonState("updating");
        addLog("Update started");
    };

    const cancelUpdate = () => {
        setProgressActive(false);
        setAddonState("error");
        addLog("Update cancelled");
    };

    const launch = () => {
        addLog("Launch requested");
        return invoke("launch_desktop_app")
            .then(() => {
                addLog("Desktop app launched");
                return true;
            })
            .catch((err) => {
                addLog(`Launch failed: ${String(err)}`);
                return false;
            });
    };

    const forceRecheck = () => {
        addLog("Force recheck requested");
        setDesktopState("updating");
        setAddonState("updating");
        setIntegrityState("updating");
        setProgressActive(true);
        setPercent(0);
        setTimeout(() => setDesktopState("ok"), 700);
        setTimeout(() => setIntegrityState("ok"), 1100);
        setTimeout(() => setAddonState("ok"), 1600);
        setTimeout(() => setProgressActive(false), 1900);
    };

    useEffect(() => {
        if (!progressActive) return;

        const id = window.setInterval(() => {
            setPercent((p) => {
                const next = Math.min(100, p + Math.max(1, Math.floor(Math.random() * 4)));
                if (next >= 100) {
                    window.clearInterval(id);
                    setProgressActive(false);
                    setAddonState("ok");
                    addLog("Addon updated successfully");
                }
                return next;
            });
        }, 220);

        return () => window.clearInterval(id);
    }, [progressActive]);

    useEffect(() => {
        invoke<string | null>("get_wow_path")
            .then((path) => setWowPath(path ?? "Not found"))
            .catch(() => setWowPath("Not found"));
        invoke<string | null>("get_desktop_path")
            .then((path) => setDesktopPath(path ?? "Not found"))
            .catch(() => setDesktopPath("Not found"));
        invoke<string | null>("get_desktop_version")
            .then((version) => setDesktopVersion(version ?? "Unknown"))
            .catch(() => setDesktopVersion("Unknown"));
        invoke<string | null>("get_addon_version")
            .then((version) => setAddonVersion(version ?? "Unknown"))
            .catch(() => setAddonVersion("Unknown"));
        invoke<Manifest>("get_manifest")
            .then((manifest) => {
                setAddonTarget(manifest.addon?.version ?? "Unknown");
                setDesktopTarget(manifest.desktop?.version ?? "Unknown");
                addLog("Manifest loaded");
            })
            .catch((err) => {
                setAddonTarget("Unknown");
                setDesktopTarget("Unknown");
                addLog(`Manifest load failed: ${String(err)}`);
            });
    }, []);

    const canLaunch = useMemo(() => {
        return desktopState === "ok" && addonState === "ok" && integrityState === "ok" && !progressActive;
    }, [desktopState, addonState, integrityState, progressActive]);

    const primaryLabel = useMemo(() => {
        if (canLaunch) return "LAUNCH APPLICATION";
        if (desktopState === "error" || addonState === "error" || integrityState === "error") return "FIX REQUIRED";
        return "UPDATING…";
    }, [canLaunch, desktopState, addonState, integrityState]);

    const status: LauncherStatus = {
        desktop: { state: desktopState, version: desktopVersion, target: desktopTarget },
        addon: { state: addonState, version: addonVersion, target: addonTarget },
        integrity: { state: integrityState, label: integrityState === "ok" ? "Verified" : "Checking…" },
        environment: { wowPath, desktopPath },
        progress: {
            active: progressActive,
            percent,
            label: progressActive ? "Updating Addon" : "Up to date",
            detail: progressActive ? "Downloading: PvPScalpel_Addon.zip" : "Ready",
            rate: progressActive ? "6.2 MB/s" : "",
        },
        canLaunch,
        primaryLabel,
    };

    const actions: LauncherActions = {
        startUpdate,
        cancelUpdate,
        launch,
        forceRecheck,
        addLog,
        logs,
    };

    return { status, actions };
}














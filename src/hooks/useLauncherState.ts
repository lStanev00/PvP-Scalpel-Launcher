import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
type LauncherSnapshot = {
    wowPath: string | null;
    desktopPath: string | null;
    desktopVersion: string | null;
    addonVersion: string | null;
    desktopTarget: string | null;
    addonTarget: string | null;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
let cachedLogs: string[] = [];
let bootstrapped = false;
let lastRawLog: string | null = null;

const ts = () => {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export function useLauncherState(): { status: LauncherStatus; actions: LauncherActions } {
    const [logs, setLogs] = useState<string[]>(cachedLogs);

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

    const addLog = (line: string) => {
        if (lastRawLog === line) return;
        lastRawLog = line;
        const next = [...cachedLogs, `[${ts()}] ${line}`];
        cachedLogs = next.length > 250 ? next.slice(-250) : next;
        setLogs(cachedLogs);
    };

    const startUpdate = () => {
        setProgressActive(true);
        setAddonState("updating");
    };

    const cancelUpdate = () => {
        setProgressActive(false);
        setAddonState("error");
    };


    const launch = () => {
        return invoke("launch_desktop_app")
            .then(() => true)
            .catch(() => false);
    };

    const forceRecheck = () => {
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
                }
                return next;
            });
        }, 220);

        return () => window.clearInterval(id);
    }, [progressActive]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | null = null;

        const loadState = async () => {
            try {
                const snapshot = await invoke<LauncherSnapshot>("get_launcher_snapshot");
                if (cancelled) return;
                setWowPath(snapshot.wowPath ?? "Not found");
                setDesktopPath(snapshot.desktopPath ?? "Not found");
                setDesktopVersion(snapshot.desktopVersion ?? "Unknown");
                setAddonVersion(snapshot.addonVersion ?? "Unknown");
                setDesktopTarget(snapshot.desktopTarget ?? "Unknown");
                setAddonTarget(snapshot.addonTarget ?? "Unknown");
            } catch {
                if (cancelled) return;
                setWowPath("Not found");
                setDesktopPath("Not found");
                setDesktopVersion("Unknown");
                setAddonVersion("Unknown");
                setAddonTarget("Unknown");
                setDesktopTarget("Unknown");
            }
        };

        const setup = async () => {
            unlisten = await listen<string>("launcher-log", (event) => {
                addLog(event.payload);
            });
            if (!bootstrapped) {
                await loadState();
                if (!cancelled) {
                    bootstrapped = true;
                }
            }
        };

        setup();

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, []);

    const canLaunch = useMemo(() => {
        return desktopState === "ok" && addonState === "ok" && integrityState === "ok" && !progressActive;
    }, [desktopState, addonState, integrityState, progressActive]);

    const primaryLabel = useMemo(() => {
        if (canLaunch) return "LAUNCH APPLICATION";
        if (desktopState === "error" || addonState === "error" || integrityState === "error") return "FIX REQUIRED";
        return "UPDATING";
    }, [canLaunch, desktopState, addonState, integrityState]);

    const status: LauncherStatus = {
        desktop: { state: desktopState, version: desktopVersion, target: desktopTarget },
        addon: { state: addonState, version: addonVersion, target: addonTarget },
        integrity: { state: integrityState, label: integrityState === "ok" ? "Verified" : "Checking" },
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














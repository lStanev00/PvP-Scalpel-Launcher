import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveLauncherState, type ComponentState, type IntegrityStatus } from "../state/launcherState";

export type Health = "ok" | "checking" | "updating" | "required" | "error";

export type PrimaryTone = "accent" | "required" | "danger" | "muted";

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
    primaryEnabled: boolean;
    primaryTone: PrimaryTone;
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

type DetectionPhase = "IDLE" | "DETECTING" | "RESOLVED";

const pad2 = (n: number) => String(n).padStart(2, "0");
let cachedLogs: string[] = [];
let lastRawLog: string | null = null;
let cachedSnapshot: LauncherSnapshot | null = null;
let cachedSnapshotError = false;
let bootstrapPromise:
    | Promise<{ snapshot: LauncherSnapshot | null; error: boolean }>
    | null = null;

const isMissing = (value: string | null | undefined) =>
    !value || value === "Not found" || value === "Unknown" || value === "Detecting...";

const mapComponentState = (state: ComponentState): Health => {
    switch (state) {
        case "INSTALLED_OK":
            return "ok";
        case "CHECKING":
            return "checking";
        case "UPDATING":
            return "updating";
        case "NOT_INSTALLED":
        case "INSTALLED_OUTDATED":
            return "required";
        default:
            return "error";
    }
};

const mapIntegrity = (status: IntegrityStatus): { state: Health; label: string } => {
    switch (status) {
        case "VERIFIED":
            return { state: "ok", label: "Verified" };
        case "CHECKING":
            return { state: "checking", label: "Checking" };
        default:
            return { state: "required", label: "Incomplete" };
    }
};

const resolveComponent = ({
    path,
    version,
    target,
    checking,
    errored,
}: {
    path: string | null | undefined;
    version: string | null | undefined;
    target: string | null | undefined;
    checking: boolean;
    errored: boolean;
}): ComponentState => {
    if (checking) return "CHECKING";
    if (errored) return "ERROR";
    if (isMissing(path) || isMissing(version)) return "NOT_INSTALLED";
    if (isMissing(target)) return "ERROR";
    if (version === target) return "INSTALLED_OK";
    return "INSTALLED_OUTDATED";
};

const ts = () => {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export function useLauncherState(): { status: LauncherStatus; actions: LauncherActions } {
    const [logs, setLogs] = useState<string[]>(cachedLogs);

    const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
    const [detectionPhase, setDetectionPhase] = useState<DetectionPhase>("IDLE");
    const [snapshotError, setSnapshotError] = useState(false);
    const [detectionTick, setDetectionTick] = useState(0);

    const addLog = (line: string) => {
        if (lastRawLog === line) return;
        lastRawLog = line;
        const next = [...cachedLogs, `[${ts()}] ${line}`];
        cachedLogs = next.length > 250 ? next.slice(-250) : next;
        setLogs(cachedLogs);
    };

    const startUpdate = () => {
        setDetectionTick((value) => value + 1);
    };

    const cancelUpdate = () => {
    };


    const launch = () => {
        return invoke("launch_desktop_app")
            .then(() => true)
            .catch(() => false);
    };

    const forceRecheck = () => {
        setDetectionTick((value) => value + 1);
    };

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen<string>("launcher-log", (event) => {
            addLog(event.payload);
        }).then((stop) => {
            unlisten = stop;
        });
        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadState = async () => {
            if (detectionTick === 0 && (cachedSnapshot || cachedSnapshotError)) {
                setSnapshot(cachedSnapshot);
                setSnapshotError(cachedSnapshotError);
                setDetectionPhase("RESOLVED");
                return;
            }

            setDetectionPhase("DETECTING");
            const runDetection = async () => {
                try {
                    const nextSnapshot = await invoke<LauncherSnapshot>("get_launcher_snapshot");
                    return { snapshot: nextSnapshot, error: false };
                } catch {
                    return { snapshot: null, error: true };
                }
            };

            const resultPromise =
                detectionTick === 0
                    ? bootstrapPromise ?? (bootstrapPromise = runDetection())
                    : runDetection();

            const result = await resultPromise;
            if (cancelled) return;
            setSnapshot(result.snapshot);
            setSnapshotError(result.error);
            setDetectionPhase("RESOLVED");
            cachedSnapshot = result.snapshot;
            cachedSnapshotError = result.error;
            bootstrapPromise = Promise.resolve(result);
        };

        loadState();

        return () => {
            cancelled = true;
        };
    }, [detectionTick]);

    const isDetecting = detectionPhase !== "RESOLVED";

    const wowPath = useMemo(() => {
        if (snapshot?.wowPath) return snapshot.wowPath;
        return isDetecting ? "Detecting..." : "Not found";
    }, [isDetecting, snapshot]);
    const desktopPath = useMemo(() => {
        if (snapshot?.desktopPath) return snapshot.desktopPath;
        return isDetecting ? "Detecting..." : "Not found";
    }, [isDetecting, snapshot]);
    const desktopVersion = useMemo(() => {
        if (snapshot?.desktopVersion) return snapshot.desktopVersion;
        return isDetecting ? "Detecting..." : "Unknown";
    }, [isDetecting, snapshot]);
    const addonVersion = useMemo(() => {
        if (snapshot?.addonVersion) return snapshot.addonVersion;
        return isDetecting ? "Detecting..." : "Unknown";
    }, [isDetecting, snapshot]);
    const desktopTarget = useMemo(() => {
        if (snapshot?.desktopTarget) return snapshot.desktopTarget;
        return isDetecting ? "Detecting..." : "Unknown";
    }, [isDetecting, snapshot]);
    const addonTarget = useMemo(() => {
        if (snapshot?.addonTarget) return snapshot.addonTarget;
        return isDetecting ? "Detecting..." : "Unknown";
    }, [isDetecting, snapshot]);

    const desktopComponent = useMemo(
        () =>
            resolveComponent({
                path: snapshot?.desktopPath,
                version: snapshot?.desktopVersion,
                target: snapshot?.desktopTarget,
                checking: isDetecting,
                errored: snapshotError,
            }),
        [isDetecting, snapshot, snapshotError],
    );

    const addonComponent = useMemo(
        () =>
            resolveComponent({
                path: snapshot?.wowPath,
                version: snapshot?.addonVersion,
                target: snapshot?.addonTarget,
                checking: isDetecting,
                errored: snapshotError,
            }),
        [isDetecting, snapshot, snapshotError],
    );

    const resolved = useMemo(
        () => resolveLauncherState({ desktop: desktopComponent, addon: addonComponent }),
        [addonComponent, desktopComponent],
    );

    const canLaunch = resolved.globalState === "READY";
    const needsInstallOrUpdate =
        desktopComponent === "NOT_INSTALLED" ||
        desktopComponent === "INSTALLED_OUTDATED" ||
        addonComponent === "NOT_INSTALLED" ||
        addonComponent === "INSTALLED_OUTDATED";
    const hasError = desktopComponent === "ERROR" || addonComponent === "ERROR";

    const primaryTone: PrimaryTone = canLaunch
        ? "accent"
        : hasError
          ? "danger"
          : needsInstallOrUpdate
            ? "required"
            : "muted";

    const integrity = mapIntegrity(resolved.integrityStatus);
    const progressActive = resolved.showProgressBar;
    const status: LauncherStatus = {
        desktop: { state: mapComponentState(desktopComponent), version: desktopVersion, target: desktopTarget },
        addon: { state: mapComponentState(addonComponent), version: addonVersion, target: addonTarget },
        integrity,
        environment: { wowPath, desktopPath },
        progress: {
            active: progressActive,
            percent: progressActive ? 0 : 0,
            label: progressActive ? "Checking integrity" : "",
            detail: progressActive ? "Verifying required components" : "",
            rate: "",
        },
        canLaunch,
        primaryLabel: resolved.primaryActionLabel,
        primaryEnabled: resolved.primaryActionEnabled,
        primaryTone,
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














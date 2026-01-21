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
    selfUpdate: {
        blocking: boolean;
        status: SelfUpdateStatus;
        title: string;
        detail: string;
        progressLabel: string;
        progressPercent: number;
        showProgress: boolean;
        actionLabel: string;
        actionEnabled: boolean;
    };
};

export type LauncherActions = {
    startUpdate: () => void;
    cancelUpdate: () => void;
    launch: () => Promise<boolean>;
    forceRecheck: () => void;
    startLauncherUpdate: () => void;
    retryLauncherUpdate: () => void;
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
type ActionPhase = "IDLE" | "REQUEST_URL" | "DOWNLOADING" | "INSTALLING" | "VERIFYING" | "ERROR";
type ActionTarget = "desktop" | "addon" | null;
type SelfUpdateStatus = "CHECKING" | "UP_TO_DATE" | "UPDATE_REQUIRED" | "DOWNLOADING" | "INSTALLING" | "ERROR";

type ActionProgressEvent = {
    phase: ActionPhase;
    progress: number | null;
    message: string;
    log: string;
};

type LauncherUpdateProgressEvent = {
    phase: "DOWNLOADING" | "INSTALLING";
    progress: number | null;
    message: string;
    log: string;
};

type ActionResult = {
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
};

type LauncherUpdateCheck = {
    status: "UP_TO_DATE" | "UPDATE_REQUIRED" | "ERROR";
    localVersion: string | null;
    remoteVersion: string | null;
    errorMessage?: string | null;
};

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
            return { state: "ok", label: "You're up to date" };
        case "CHECKING":
            return { state: "checking", label: "Checking for updates…" };
        default:
            return { state: "required", label: "Update available" };
    }
};

const progressLabelForPhase = (phase: ActionPhase, target: ActionTarget) => {
    switch (phase) {
        case "REQUEST_URL":
        case "VERIFYING":
            return "Checking for updates…";
        case "DOWNLOADING":
            return "Downloading update…";
        case "INSTALLING":
            if (target === "addon") return "Installing addon…";
            if (target === "desktop") return "Installing application…";
            return "Installing update…";
        case "ERROR":
            return "Something went wrong";
        default:
            return "";
    }
};

const progressDetailForPhase = (phase: ActionPhase) => {
    if (phase === "DOWNLOADING") return "This may take a moment";
    if (phase === "ERROR") return "Please try again";
    return "";
};

const resolveComponent = ({
    path,
    version,
    target,
    checking,
    updating,
    errored,
}: {
    path: string | null | undefined;
    version: string | null | undefined;
    target: string | null | undefined;
    checking: boolean;
    updating: boolean;
    errored: boolean;
}): ComponentState => {
    if (checking) return "CHECKING";
    if (updating) return "UPDATING";
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
    const [actionPhase, setActionPhase] = useState<ActionPhase>("IDLE");
    const [actionProgress, setActionProgress] = useState<number | null>(null);
    const [actionMessage, setActionMessage] = useState("");
    const [actionTarget, setActionTarget] = useState<ActionTarget>(null);
    const [selfUpdateStatus, setSelfUpdateStatus] = useState<SelfUpdateStatus>("CHECKING");
    const [selfUpdateProgress, setSelfUpdateProgress] = useState<number | null>(null);

    const addLog = (line: string) => {
        if (lastRawLog === line) return;
        lastRawLog = line;
        const next = [...cachedLogs, `[${ts()}] ${line}`];
        cachedLogs = next.length > 250 ? next.slice(-250) : next;
        setLogs(cachedLogs);
    };

    const runSelfUpdateCheck = () => {
        setSelfUpdateStatus("CHECKING");
        setSelfUpdateProgress(null);
        invoke<LauncherUpdateCheck>("get_launcher_update_state")
            .then((result) => {
                if (result.status === "UP_TO_DATE") {
                    setSelfUpdateStatus("UP_TO_DATE");
                    return;
                }
                if (result.status === "UPDATE_REQUIRED") {
                    setSelfUpdateStatus("UPDATE_REQUIRED");
                    return;
                }
                setSelfUpdateStatus("ERROR");
            })
            .catch(() => {
                setSelfUpdateStatus("ERROR");
            });
    };

    const startUpdate = () => {
        if (selfUpdateStatus !== "UP_TO_DATE") return;
        if (!requiredAction || requiredAction === "LAUNCH") return;
        const target = requiredAction.includes("DESKTOP") ? "desktop" : "addon";
        setActionTarget(target);
        setActionPhase("REQUEST_URL");
        setActionProgress(null);
        setActionMessage("Checking for updates…");

        invoke<ActionResult>("perform_action", { action: requiredAction })
            .then((result) => {
                if (!result.ok) {
                    setActionPhase("ERROR");
                    setActionMessage("Something went wrong");
                    setActionTarget(null);
                    return;
                }
                setActionPhase("IDLE");
                setActionMessage("");
                setActionProgress(null);
                setActionTarget(null);
                setDetectionTick((value) => value + 1);
            })
            .catch((err) => {
                console.warn(err)
                setActionPhase("ERROR");
                setActionMessage("Something went wrong");
                setActionTarget(null);
            });
    };

    const cancelUpdate = () => {
        invoke("cancel_action").catch(() => undefined);
        setActionPhase("ERROR");
        setActionMessage("Something went wrong");
        setActionTarget(null);
    };

    const startLauncherUpdate = () => {
        if (selfUpdateStatus !== "UPDATE_REQUIRED") return;
        setSelfUpdateStatus("DOWNLOADING");
        setSelfUpdateProgress(0);
        invoke<ActionResult>("perform_launcher_update")
            .then((result) => {
                if (!result.ok) {
                    setSelfUpdateStatus("ERROR");
                }
            })
            .catch(() => {
                setSelfUpdateStatus("ERROR");
            });
    };

    const retryLauncherUpdate = () => {
        runSelfUpdateCheck();
    };

    useEffect(() => {
        runSelfUpdateCheck();
    }, []);

    const launch = () => {
        return invoke("launch_desktop_app")
            .then(() => true)
            .catch(() => false);
    };

    const forceRecheck = () => {
        invoke("invalidate_manifest_cache").catch(() => undefined);
        setDetectionTick((value) => value + 1);
    };

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        const unlistenTasks: Array<() => void> = [];
        listen<string>("launcher-log", (event) => {
            addLog(event.payload);
        }).then((stop) => {
            unlistenTasks.push(stop);
        });
        listen<ActionProgressEvent>("action-progress", (event) => {
            const payload = event.payload;
            setActionPhase(payload.phase);
            setActionProgress(payload.progress ?? null);
            setActionMessage(payload.message);
            if (payload.log) addLog(payload.log);
        }).then((stop) => {
            unlistenTasks.push(stop);
        });
        listen<LauncherUpdateProgressEvent>("launcher-update-progress", (event) => {
            const payload = event.payload;
            setSelfUpdateStatus(payload.phase);
            setSelfUpdateProgress(payload.progress ?? null);
            if (payload.log) addLog(payload.log);
        }).then((stop) => {
            unlistenTasks.push(stop);
        });
        unlisten = () => {
            unlistenTasks.forEach((stop) => stop());
        };
        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadState = async () => {
            if (selfUpdateStatus !== "UP_TO_DATE") {
                setDetectionPhase("IDLE");
                return;
            }
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
    }, [detectionTick, selfUpdateStatus]);

    const isDetecting = detectionPhase !== "RESOLVED";
    const isUpdating = actionPhase !== "IDLE" && actionPhase !== "ERROR";

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
                updating: isUpdating && actionTarget === "desktop",
                errored: snapshotError,
            }),
        [actionTarget, isDetecting, isUpdating, snapshot, snapshotError],
    );

    const addonComponent = useMemo(
        () =>
            resolveComponent({
                path: snapshot?.wowPath,
                version: snapshot?.addonVersion,
                target: snapshot?.addonTarget,
                checking: isDetecting,
                updating: isUpdating && actionTarget === "addon",
                errored: snapshotError,
            }),
        [actionTarget, isDetecting, isUpdating, snapshot, snapshotError],
    );

    const resolved = useMemo(
        () => resolveLauncherState({ desktop: desktopComponent, addon: addonComponent }),
        [addonComponent, desktopComponent],
    );

    const requiredAction = useMemo(() => {
        if (desktopComponent === "NOT_INSTALLED") return "INSTALL_DESKTOP";
        if (desktopComponent === "INSTALLED_OUTDATED") return "UPDATE_DESKTOP";
        if (addonComponent === "NOT_INSTALLED") return "INSTALL_ADDON";
        if (addonComponent === "INSTALLED_OUTDATED") return "UPDATE_ADDON";
        if (resolved.globalState === "READY") return "LAUNCH";
        return null;
    }, [addonComponent, desktopComponent, resolved.globalState]);

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

    const errorIntegrity: { state: Health; label: string } = { state: "error", label: "Something went wrong" };
    const integrity = hasError ? errorIntegrity : mapIntegrity(resolved.integrityStatus);
    const progressActive = resolved.showProgressBar;
    const selfUpdateBlocking = selfUpdateStatus !== "UP_TO_DATE";
    const selfUpdateShowProgress = selfUpdateStatus === "DOWNLOADING" || selfUpdateStatus === "INSTALLING";
    const selfUpdateTitle =
        selfUpdateStatus === "ERROR"
            ? "Something went wrong"
            : selfUpdateStatus === "CHECKING"
              ? "Checking for updates…"
              : "Launcher update required";
    const selfUpdateDetail = selfUpdateStatus === "ERROR" ? "Please try again" : "";
    const selfUpdateProgressLabel =
        selfUpdateStatus === "DOWNLOADING"
            ? "Downloading update…"
            : selfUpdateStatus === "INSTALLING"
              ? "Installing update…"
              : "";
    const selfUpdateActionLabel = selfUpdateStatus === "ERROR" ? "Retry" : "Update & Restart";
    const selfUpdateActionEnabled = selfUpdateStatus === "UPDATE_REQUIRED" || selfUpdateStatus === "ERROR";
    const selfUpdatePercent = selfUpdateShowProgress ? selfUpdateProgress ?? 0 : 0;
    const status: LauncherStatus = {
        desktop: { state: mapComponentState(desktopComponent), version: desktopVersion, target: desktopTarget },
        addon: { state: mapComponentState(addonComponent), version: addonVersion, target: addonTarget },
        integrity,
        environment: { wowPath, desktopPath },
        progress: {
            active: progressActive,
            percent: progressActive ? actionProgress ?? 0 : 0,
            label: progressActive ? progressLabelForPhase(actionPhase, actionTarget) || actionMessage : "",
            detail: progressActive ? progressDetailForPhase(actionPhase) : "",
            rate: "",
        },
        canLaunch,
        primaryLabel: resolved.primaryActionLabel,
        primaryEnabled: resolved.primaryActionEnabled,
        primaryTone,
        selfUpdate: {
            blocking: selfUpdateBlocking,
            status: selfUpdateStatus,
            title: selfUpdateTitle,
            detail: selfUpdateDetail,
            progressLabel: selfUpdateProgressLabel,
            progressPercent: selfUpdatePercent,
            showProgress: selfUpdateShowProgress,
            actionLabel: selfUpdateActionLabel,
            actionEnabled: selfUpdateActionEnabled,
        },
    };

    const actions: LauncherActions = {
        startUpdate,
        cancelUpdate,
        launch,
        forceRecheck,
        startLauncherUpdate,
        retryLauncherUpdate,
        addLog,
        logs,
    };

    return { status, actions };
}














import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LuMinus, LuSquare, LuX } from "react-icons/lu";
import styles from "./Launcher.module.css";
import { StatusTile } from "../components/StatusTile/StatusTile";
import { ProgressBar } from "../components/ProgressBar/ProgressBar";
import { PrimaryButton } from "../components/PrimaryButton/PrimaryButton";
import { Modal } from "../components/Modal/Modal";
import { LogsDrawer } from "../components/LogsDrawer/LogsDrawer";
import { useLauncherState } from "../hooks/useLauncherState";

export default function Launcher() {
    const { status, actions } = useLauncherState();

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [uiReady] = useState(true);
    const [introActive, setIntroActive] = useState(true);
    const [revealActive, setRevealActive] = useState(false);
    const [showUi, setShowUi] = useState(false);
    const [introCycle, setIntroCycle] = useState(0);
    const [forceIntro, setForceIntro] = useState(true);
    const [minimizeToTray, setMinimizeToTray] = useState(() => {
        const stored = localStorage.getItem("minimizeToTray");
        return stored ? stored === "true" : true;
    });
    const closeListenerRef = useRef<null | (() => void)>(null);
    const minimizeToTrayRef = useRef(minimizeToTray);
    const entranceTimerRef = useRef<number | null>(null);
    const revealTimerRef = useRef<number | null>(null);
    const introDoneRef = useRef(false);

    const primaryTone = useMemo(() => {
        if (status.canLaunch) return "accent";
        if (
            status.desktop.state === "error" ||
            status.addon.state === "error" ||
            status.integrity.state === "error"
        )
            return "danger";
        return "muted";
    }, [status]);

    const getAppWindow = () => {
        try {
            return getCurrentWindow();
        } catch {
            return null;
        }
    };

    useEffect(() => {
        const win = getAppWindow();
        if (win) {
            win.setShadow(false).catch(() => undefined);
        }
    }, []);

    useEffect(() => {
        const stored = localStorage.getItem("minimizeToTray");
        if (stored === null) {
            localStorage.setItem("minimizeToTray", "true");
        }
    }, []);

    useEffect(() => {
        const id = window.setTimeout(() => setForceIntro(false), 30);
        return () => window.clearTimeout(id);
    }, []);

    const finishIntro = () => {
        if (introDoneRef.current) return;
        introDoneRef.current = true;
        if (entranceTimerRef.current) window.clearTimeout(entranceTimerRef.current);
        setIntroActive(false);
        setShowUi(true);
        setRevealActive(true);
        if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = window.setTimeout(() => setRevealActive(false), 900);
    };

    const startIntro = (durationMs: number) => {
        if (entranceTimerRef.current) window.clearTimeout(entranceTimerRef.current);
        if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
        introDoneRef.current = false;
        setRevealActive(false);
        setIntroActive(true);
        setShowUi(false);
        setIntroCycle((value) => value + 1);
        entranceTimerRef.current = window.setTimeout(() => {
            finishIntro();
        }, durationMs);
    };

    useEffect(() => {
        startIntro(5000);
        return () => {
            if (entranceTimerRef.current) window.clearTimeout(entranceTimerRef.current);
            if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
        };
    }, []);

    useEffect(() => {
        const win = getAppWindow();
        if (!win) return undefined;

        let cancelled = false;
        win.onCloseRequested(async (event) => {
            event.preventDefault();
            if (minimizeToTrayRef.current) {
                await hideToTray();
                return;
            }
            await exitApp();
        }).then((stop) => {
            if (cancelled) {
                stop();
                return;
            }
            if (closeListenerRef.current) closeListenerRef.current();
            closeListenerRef.current = stop;
        });

        return () => {
            cancelled = true;
            if (closeListenerRef.current) {
                closeListenerRef.current();
                closeListenerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        localStorage.setItem("minimizeToTray", String(minimizeToTray));
        minimizeToTrayRef.current = minimizeToTray;
        if (!minimizeToTray) {
            const win = getAppWindow();
            if (win) {
                win.setSkipTaskbar(false).catch(() => undefined);
            }
        }
    }, [minimizeToTray]);

    useEffect(() => {
        const statusText = status.progress.active
            ? status.progress.label
            : status.canLaunch
              ? "Ready"
              : "Locked";
        invoke("update_tray_state", {
            canLaunch: status.canLaunch,
            statusText,
        }).catch(() => undefined);
    }, [status.canLaunch, status.progress.active, status.progress.label]);

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen("tray-launch", async () => {
            await showFromTray();
            if (status.canLaunch) {
                const launched = await actions.launch();
                if (launched) {
                    await exitApp();
                }
            }
        }).then((stop) => {
            unlisten = stop;
        });
        return () => {
            if (unlisten) unlisten();
        };
    }, [actions, status.canLaunch]);

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen("tray-show", () => {
            showFromTray();
        }).then((stop) => {
            unlisten = stop;
        });
        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    const handleHeaderDrag = async (event: MouseEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target.closest("button, a, input, textarea, select, [data-no-drag]")) return;
        const win = getAppWindow();
        if (win) await win.startDragging();
    };

    const hideToTray = async () => {
        const win = getAppWindow();
        if (!win) return;
        await win.setSkipTaskbar(true).catch(() => undefined);
        await win.minimize().catch(() => undefined);
        await win.hide().catch(() => undefined);
    };

    const showFromTray = async () => {
        const win = getAppWindow();
        if (!win) return;
        if (entranceTimerRef.current) window.clearTimeout(entranceTimerRef.current);
        if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
        setIntroActive(false);
        setRevealActive(false);
        setShowUi(true);
        await win.setSkipTaskbar(false).catch(() => undefined);
        await win.unminimize().catch(() => undefined);
        await win.show().catch(() => undefined);
        await win.center().catch(() => undefined);
        await win.setFocus().catch(() => undefined);
    };

    const handleIntroEnd = () => {
        finishIntro();
    };

    const exitApp = async () => {
        try {
            await invoke("exit_app");
        } catch {
            const win = getAppWindow();
            if (win) await win.close();
        }
    };

    const onPrimary = async () => {
        if (status.canLaunch) {
            const launched = await actions.launch();
            if (launched) {
                await exitApp();
            }
            return;
        }
        if (primaryTone === "danger") {
            setLogsOpen(true);
            return;
        }
        actions.startUpdate();
    };

    return (
        <div className={styles.shell}>
            <div className={styles.bgNoise} />
            <div
                className={`${styles.frame} ${uiReady ? styles.frameReady : ""} ${
                    introActive || forceIntro ? styles.frameIntro : ""
                } ${revealActive ? styles.frameReveal : ""}`}
                style={{ boxShadow: "none" }}
            >
                <div className={`${styles.introOverlay} ${introActive ? styles.introActive : styles.introHidden}`}>
                    <div
                        key={introCycle}
                        className={styles.introLogo}
                        onAnimationEnd={handleIntroEnd}
                    />
                </div>
                {showUi && (
                    <>
                        <header className={styles.header} onMouseDown={handleHeaderDrag}>
                    <div className={styles.headerDrag}>
                        <div className={styles.brand}>
                            <div className={styles.logo} />
                            <div>
                                <div className={styles.name}>PvP Scalpel</div>
                                <div className={styles.sub}>Launcher / Patcher / Integrity</div>
                            </div>
                        </div>
                    </div>

                    <div className={styles.headerActions} data-no-drag>
                        <div className={styles.actions}>
                            <button className={styles.iconBtn} onClick={() => setLogsOpen((p) => !p)}>
                                Logs
                            </button>
                            <button className={styles.iconBtn} onClick={() => setSettingsOpen(true)}>
                                Settings
                            </button>
                        </div>
                        <div className={styles.windowControls}>
                            <button
                                className={styles.winBtn}
                                type="button"
                                onClick={async (event) => {
                                    event.stopPropagation();
                                    const win = getAppWindow();
                                    if (!win) return;
                                    if (minimizeToTrayRef.current) {
                                        await hideToTray();
                                        return;
                                    }
                                    await win.minimize();
                                }}
                                aria-label="Minimize window"
                                title="Minimize"
                            >
                                <LuMinus aria-hidden="true" />
                            </button>
                            <button
                                className={styles.winBtn}
                                type="button"
                                onClick={async (event) => {
                                    event.stopPropagation();
                                    const win = getAppWindow();
                                    if (win) await win.toggleMaximize();
                                }}
                                aria-label="Maximize window"
                                title="Maximize"
                            >
                                <LuSquare aria-hidden="true" />
                            </button>
                            <button
                                className={`${styles.winBtn} ${styles.winClose}`}
                                type="button"
                                onClick={async (event) => {
                                    event.stopPropagation();
                                    const win = getAppWindow();
                                    if (!win) return;
                                    if (minimizeToTrayRef.current) {
                                        await hideToTray();
                                        return;
                                    }
                                    await exitApp();
                                }}
                                aria-label="Close window"
                                title="Close"
                            >
                                <LuX aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                        </header>

                        <main className={styles.main}>
                    <section className={styles.hero}>
                        <div className={styles.heroTop}>
                            <div className={styles.heroTitle}>Ready-to-fight build integrity</div>
                            <div className={styles.heroHint}>
                                Desktop and addon versions are kept in lockstep. Launch is unlocked only when checks
                                pass.
                            </div>
                        </div>

                        <div className={styles.grid}>
                            <StatusTile
                                title="Desktop"
                                state={status.desktop.state}
                                left={`v${status.desktop.version}`}
                                right={`target v${status.desktop.target}`}
                            />
                            <StatusTile
                                title="Addon"
                                state={status.addon.state}
                                left={`v${status.addon.version}`}
                                right={`target v${status.addon.target}`}
                            />
                            <StatusTile
                                title="Integrity"
                                state={status.integrity.state}
                                left={status.integrity.label}
                            />
                        </div>

                        <div className={styles.progress}>
                            <ProgressBar
                                percent={status.progress.percent}
                                active={status.progress.active}
                                label={status.progress.label}
                                detail={status.progress.detail}
                                rate={status.progress.rate}
                            />
                        </div>

                        <div className={styles.primary}>
                            <PrimaryButton
                                label={status.primaryLabel}
                                disabled={!status.canLaunch && primaryTone !== "danger"}
                                tone={primaryTone as any}
                                onClick={onPrimary}
                            />
                            <div className={styles.row}>
                                <button className={styles.linkBtn} onClick={actions.forceRecheck}>
                                    Force recheck
                                </button>
                                <span className={styles.sep} />
                                <button className={styles.linkBtn} onClick={() => setLogsOpen(true)}>
                                    View details
                                </button>
                            </div>
                        </div>
                    </section>

                    <aside className={styles.side}>
                        <div className={styles.card}>
                            <div className={styles.cardTitle}>Environment</div>
                            <div className={styles.kv}>
                                <div className={styles.k}>WoW Path</div>
                                <div className={styles.v}>{status.environment.wowPath}</div>
                            </div>
                            <div className={styles.kv}>
                                <div className={styles.k}>Desktop App</div>
                                <div className={styles.v}>{status.environment.desktopPath}</div>
                            </div>
                            <div className={styles.kv}>
                                <div className={styles.k}>Channel</div>
                                <div className={styles.v}>Stable</div>
                            </div>
                        </div>

                        <div className={styles.card}>
                            <div className={styles.cardTitle}>Patch Notes</div>
                            <div className={styles.note}>
                                <div className={styles.noteHead}>v1.4.2</div>
                                <div className={styles.noteText}>
                                    Improved addon sync, faster integrity verification, and cleaner error handling.
                                </div>
                            </div>
                            <div className={styles.note}>
                                <div className={styles.noteHead}>v1.4.1</div>
                                <div className={styles.noteText}>
                                    Launcher UI overhaul and tighter update gating for safe launches.
                                </div>
                            </div>
                        </div>
                    </aside>
                        </main>
                    </>
                )}
            </div>

            {showUi && (
                <>
                    <LogsDrawer open={logsOpen} lines={actions.logs} onToggle={() => setLogsOpen((p) => !p)} />

                    <Modal open={settingsOpen} title="Settings" onClose={() => setSettingsOpen(false)}>
                        <div className={styles.settingsGrid}>
                            <div className={styles.field}>
                                <div className={styles.label}>WoW install path</div>
                                <input className={styles.input} value={status.environment.wowPath} readOnly />
                            </div>
                            <div className={styles.field}>
                                <div className={styles.label}>Addon folder</div>
                                <input className={styles.input} value="Interface/AddOns/PvPScalpel" readOnly />
                            </div>
                            <div className={styles.field}>
                                <div className={styles.label}>Minimize to tray on close</div>
                                <label className={styles.toggle}>
                                    <input
                                        className={styles.toggleInput}
                                        type="checkbox"
                                        checked={minimizeToTray}
                                        onChange={(event) => setMinimizeToTray(event.target.checked)}
                                    />
                                    <span className={styles.toggleTrack} />
                                    <span className={styles.toggleText}>
                                        {minimizeToTray ? "Enabled" : "Disabled"}
                                    </span>
                                </label>
                            </div>
                            <div className={styles.fieldRow}>
                                <button className={styles.ghostBtn} onClick={actions.forceRecheck}>
                                    Force recheck
                                </button>
                                <button className={styles.ghostBtn} onClick={() => setLogsOpen(true)}>
                                    Open logs
                                </button>
                            </div>
                        </div>
                    </Modal>
                </>
            )}
        </div>
    );
}
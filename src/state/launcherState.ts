export type ComponentState =
    | "NOT_INSTALLED"
    | "INSTALLED_OUTDATED"
    | "INSTALLED_OK"
    | "CHECKING"
    | "UPDATING"
    | "ERROR";

export type ComponentsState = {
    desktop: ComponentState;
    addon: ComponentState;
};

export type GlobalState = "READY" | "BLOCKED" | "UPDATING";
export type IntegrityStatus = "VERIFIED" | "INCOMPLETE" | "CHECKING";

export type ResolvedLauncherState = {
    globalState: GlobalState;
    primaryActionLabel: string;
    primaryActionEnabled: boolean;
    showProgressBar: boolean;
    integrityStatus: IntegrityStatus;
};

export function resolveLauncherState(components: ComponentsState): ResolvedLauncherState {
    const { desktop, addon } = components;
    const anyChecking = desktop === "CHECKING" || addon === "CHECKING";
    const anyUpdating = desktop === "UPDATING" || addon === "UPDATING";
    const anyError = desktop === "ERROR" || addon === "ERROR";
    const desktopNotInstalled = desktop === "NOT_INSTALLED";
    const addonNotInstalled = addon === "NOT_INSTALLED";
    const desktopOutdated = desktop === "INSTALLED_OUTDATED";
    const addonOutdated = addon === "INSTALLED_OUTDATED";
    const allOk = desktop === "INSTALLED_OK" && addon === "INSTALLED_OK";

    const globalState: GlobalState = anyChecking
        ? "BLOCKED"
        : anyUpdating
          ? "UPDATING"
        : allOk
          ? "READY"
          : "BLOCKED";

    const integrityStatus: IntegrityStatus = anyChecking
        ? "CHECKING"
        : allOk
          ? "VERIFIED"
          : "INCOMPLETE";

    const showProgressBar = anyUpdating;

    let primaryActionLabel = "CHECK STATUS";
    if (anyUpdating) {
        primaryActionLabel = "UPDATING";
    } else if (anyChecking) {
        primaryActionLabel = "CHECKING";
    } else if (anyError) {
        primaryActionLabel = "FIX REQUIRED";
    } else if (desktopNotInstalled) {
        primaryActionLabel = "INSTALL DESKTOP APP";
    } else if (desktopOutdated) {
        primaryActionLabel = "UPDATE DESKTOP APP";
    } else if (addonNotInstalled) {
        primaryActionLabel = "INSTALL ADDON";
    } else if (addonOutdated) {
        primaryActionLabel = "UPDATE ADDON";
    } else if (allOk) {
        primaryActionLabel = "LAUNCH PvP SCALPEL";
    }

    const primaryActionEnabled = !anyChecking && !anyUpdating && !anyError;

    return {
        globalState,
        primaryActionLabel,
        primaryActionEnabled,
        showProgressBar,
        integrityStatus,
    };
}

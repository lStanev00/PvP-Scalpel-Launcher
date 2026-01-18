import styles from "./StatusTile.module.css";
import clsx from "clsx";
import type { Health } from "../../hooks/useLauncherState.ts";

type Props = {
    title: string;
    state: Health;
    left: string;
    right?: string;
};

export function StatusTile({ title, state, left, right }: Props) {
    const stateClass = styles[state];
    const badgeText =
        state === "ok"
            ? "OK"
            : state === "required"
              ? "REQUIRED"
              : state === "checking"
                ? "CHECKING"
                : state === "updating"
                  ? "UPDATING"
                  : "ERROR";
    return (
        <div className={clsx(styles.tile, stateClass)}>
            <div className={styles.top}>
                <div className={styles.title}>{title}</div>
                <div className={styles.badge}>
                    <span className={styles.dot} />
                    <span className={styles.badgeText}>{badgeText}</span>
                </div>
            </div>
            <div className={styles.row}>
                <div className={styles.left}>{left}</div>
                {right ? <div className={styles.right}>{right}</div> : null}
            </div>
        </div>
    );
}

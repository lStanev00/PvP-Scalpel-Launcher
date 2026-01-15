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
    return (
        <div className={clsx(styles.tile, styles[state])}>
            <div className={styles.top}>
                <div className={styles.title}>{title}</div>
                <div className={styles.badge}>
                    <span className={styles.dot} />
                    <span className={styles.badgeText}>{state.toUpperCase()}</span>
                </div>
            </div>
            <div className={styles.row}>
                <div className={styles.left}>{left}</div>
                {right ? <div className={styles.right}>{right}</div> : null}
            </div>
        </div>
    );
}

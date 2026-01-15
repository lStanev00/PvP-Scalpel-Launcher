import styles from "./LogsDrawer.module.css";
import clsx from "clsx";

type Props = {
    open: boolean;
    lines: string[];
    onToggle: () => void;
};

export function LogsDrawer({ open, lines, onToggle }: Props) {
    return (
        <div className={clsx(styles.drawer, open && styles.open)}>
            <div className={styles.handle}>
                <button className={styles.btn} onClick={onToggle}>
                    {open ? "Hide logs" : "Show logs"}
                </button>
            </div>
            <div className={styles.panel}>
                <div className={styles.head}>
                    <div className={styles.title}>Launcher Logs</div>
                    <div className={styles.meta}>{lines.length} lines</div>
                </div>
                <div className={styles.list}>
                    {lines.map((l, i) => (
                        <div key={i} className={styles.line}>
                            {l}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

import styles from "./ProgressBar.module.css";
import clsx from "clsx";

type Props = {
    percent: number;
    active: boolean;
    label: string;
    detail: string;
    rate?: string;
};

export function ProgressBar({ percent, active, label, detail, rate }: Props) {
    return (
        <div className={styles.wrap}>
            <div className={styles.meta}>
                <div className={styles.label}>
                    <span className={styles.kicker}>{label}</span>
                    <span className={styles.detail}>{detail}</span>
                </div>
                <div className={styles.rhs}>
                    {rate ? <span className={styles.rate}>{rate}</span> : null}
                    <span className={styles.pct}>{Math.round(percent)}%</span>
                </div>
            </div>

            <div className={clsx(styles.track, active && styles.active)}>
                <div className={styles.fill} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}>
                    <span className={styles.head} />
                </div>
            </div>
        </div>
    );
}

import styles from "./PrimaryButton.module.css";
import clsx from "clsx";

type Tone = "accent" | "danger" | "muted";

type Props = {
    label: string;
    disabled?: boolean;
    tone?: Tone;
    onClick?: () => void;
};

export function PrimaryButton({ label, disabled, tone = "accent", onClick }: Props) {
    return (
        <button
            className={clsx(styles.btn, styles[tone], disabled && styles.disabled)}
            onClick={disabled ? undefined : onClick}
        >
            <span className={styles.inner}>{label}</span>
        </button>
    );
}

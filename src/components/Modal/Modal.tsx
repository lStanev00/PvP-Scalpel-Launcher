import styles from "./Modal.module.css";

type Props = {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
};

export function Modal({ open, title, children, onClose }: Props) {
    if (!open) return null;

    return (
        <div className={styles.backdrop} onMouseDown={onClose}>
            <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
                <div className={styles.header}>
                    <div className={styles.title}>{title}</div>
                    <button className={styles.x} onClick={onClose}>
                        ✕
                    </button>
                </div>
                <div className={styles.body}>{children}</div>
            </div>
        </div>
    );
}

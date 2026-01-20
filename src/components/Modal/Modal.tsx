import styles from "./Modal.module.css";

type Props = {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
    showClose?: boolean;
    closeOnBackdrop?: boolean;
    modalClassName?: string;
    bodyClassName?: string;
};

export function Modal({
    open,
    title,
    children,
    onClose,
    showClose = true,
    closeOnBackdrop = true,
    modalClassName,
    bodyClassName,
}: Props) {
    if (!open) return null;

    const modalClass = [styles.modal, modalClassName].filter(Boolean).join(" ");
    const bodyClass = [styles.body, bodyClassName].filter(Boolean).join(" ");

    return (
        <div className={styles.backdrop} onMouseDown={closeOnBackdrop ? onClose : undefined}>
            <div className={modalClass} onMouseDown={(event) => event.stopPropagation()}>
                <div className={styles.header}>
                    <div className={styles.title}>{title}</div>
                    {showClose ? (
                        <button className={styles.x} onClick={onClose} aria-label="Close dialog">
                            X
                        </button>
                    ) : null}
                </div>
                <div className={bodyClass}>{children}</div>
            </div>
        </div>
    );
}

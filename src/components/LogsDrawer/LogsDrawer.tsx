import { useEffect, useRef, useState } from "react";
import styles from "./LogsDrawer.module.css";
import clsx from "clsx";

type Props = {
    open: boolean;
    lines: string[];
    onToggle: () => void;
};

export function LogsDrawer({ open, lines, onToggle }: Props) {
    const [panelHeight, setPanelHeight] = useState(300);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    useEffect(() => {
        const handleMove = (event: MouseEvent) => {
            const dragState = dragRef.current;
            if (!dragState) return;
            const delta = event.clientY - dragState.startY;
            const maxHeight = Math.max(240, Math.round(window.innerHeight * 0.6));
            const next = Math.max(180, Math.min(maxHeight, dragState.startHeight - delta));
            setPanelHeight(next);
        };

        const handleUp = () => {
            dragRef.current = null;
        };

        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", handleUp);
        return () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", handleUp);
        };
    }, []);

    const startDrag = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragRef.current = { startY: event.clientY, startHeight: panelHeight };
    };

    return (
        <div className={clsx(styles.drawer, open && styles.open)}>
            <div className={styles.handle}>
                <button className={styles.btn} onClick={onToggle}>
                    {open ? "Hide logs" : "Show logs"}
                </button>
            </div>
            <div className={styles.panel} style={{ height: open ? panelHeight : 0 }}>
                <div className={styles.resizeHandle} onMouseDown={startDrag} />
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

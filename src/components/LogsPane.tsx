import { useEffect, useRef } from "react";

export function LogsPane({ logs }: { logs: string[] }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }, [logs]);
    return (
        <div className="card bg-base-100 shadow">
            <div className="card-body p-0">
                <div className="px-4 py-3 border-b border-base-200 flex items-center justify-between">
                    <h2 className="card-title">Logs</h2>
                </div>
                <div ref={ref} className="px-4 py-3 max-h-64 overflow-auto font-mono text-sm whitespace-pre-wrap">
                    {logs.length === 0 ? (
                        <span className="opacity-70">No logs yet</span>
                    ) : logs.map((l, i) => (
                        <div key={i}>{l}</div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default LogsPane;



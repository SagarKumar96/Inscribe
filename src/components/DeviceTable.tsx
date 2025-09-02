import { ReactNode } from "react";

export interface BlockDeviceRow {
    name: string;
    path: string;
    size: string;
    model?: string;
    transport?: string;
    removable: boolean;
}

export function DeviceTable({ devices, footer }: { devices: BlockDeviceRow[]; footer?: ReactNode }) {
    return (
        <div className="card bg-base-100 shadow">
            <div className="card-body p-0">
                <div className="px-4 py-3 border-b border-base-200 flex items-center justify-between">
                    <h2 className="card-title">Detected removable drives</h2>
                </div>

                <div className="p-3 flex flex-col gap-2">
                    {devices.length === 0 && (
                        <div className="alert">
                            <span className="opacity-70">No removable drives found</span>
                        </div>
                    )}

                    {devices.map((d) => (
                        <details key={d.path} className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box">
                            <summary className="collapse-title flex items-center justify-between gap-3 cursor-pointer">
                                <div className="flex items-center gap-3 flex-wrap">
                                    <div className="font-semibold">{d.path}</div>
                                    <div className="opacity-70">{d.name}</div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="badge badge-ghost">{d.size}</div>
                                    {d.transport && (<div className="badge badge-outline">{d.transport}</div>)}
                                    {d.removable && (<div className="badge badge-primary">removable</div>)}
                                    {(!d.removable && (!d.transport || d.transport !== 'usb')) && (
                                        <div className="tooltip" data-tip="Likely a system or internal disk. Use with extreme caution.">
                                            <span className="status" style={{ color: 'var(--color-error)' }} />
                                        </div>
                                    )}
                                </div>
                            </summary>
                            <div className="collapse-content">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <div className="list">
                                        <div className="list-row">
                                            <div className="text-sm opacity-70">Device name</div>
                                            <div className="list-col-grow">{d.name}</div>
                                        </div>
                                        <div className="list-row">
                                            <div className="text-sm opacity-70">Path</div>
                                            <div className="list-col-grow break-all">{d.path}</div>
                                        </div>
                                        <div className="list-row">
                                            <div className="text-sm opacity-70">Size</div>
                                            <div className="list-col-grow">{d.size}</div>
                                        </div>
                                    </div>
                                    <div className="list">
                                        <div className="list-row">
                                            <div className="text-sm opacity-70">Model</div>
                                            <div className="list-col-grow">{d.model ?? "-"}</div>
                                        </div>
                                        <div className="list-row">
                                            <div className="text-sm opacity-70">Transport</div>
                                            <div className="list-col-grow">{d.transport ?? "-"}</div>
                                        </div>
                                        <div className="list-row">
                                            <div className="text-sm opacity-70">Removable</div>
                                            <div className="list-col-grow">{d.removable ? "Yes" : "No"}</div>
                                        </div>
                                        {(!d.removable && (!d.transport || d.transport !== 'usb')) && (
                                            <div className="alert alert-error">
                                                <span className="text-sm">This looks like a system or internal disk. Double-confirm before proceeding.</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="mt-3 flex items-center gap-2 flex-wrap">
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => navigator.clipboard?.writeText(d.path)}
                                        title="Copy device path"
                                    >
                                        Copy path
                                    </button>
                                </div>
                            </div>
                        </details>
                    ))}

                    {footer && (
                        <div className="mt-2">
                            {footer}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default DeviceTable;



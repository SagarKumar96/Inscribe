import { ReactNode } from "react";

export function AppShell({
    header,
    sidebar,
    children,
}: {
    header: ReactNode;
    sidebar: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="min-h-screen bg-base-200 text-base-content">
            <div className="navbar bg-base-100 shadow sticky top-0 z-20">
                <div className="flex-1 px-2 text-xl font-semibold">{header}</div>
                <div className="flex-none px-2">
                    {/* right actions slot is included in header component */}
                </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[18rem_1fr] gap-4 container mx-auto p-4">
                <aside className="card bg-base-100 shadow h-fit md:sticky md:top-[4.5rem]">
                    <div className="card-body p-4">
                        {sidebar}
                    </div>
                </aside>
                <main className="flex flex-col gap-4">
                    {children}
                </main>
            </div>
        </div>
    );
}

export default AppShell;



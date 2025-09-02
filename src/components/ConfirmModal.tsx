import { ReactNode } from "react";

export function ConfirmModal({ id, title, body, confirmLabel = "Confirm", onConfirm, disabled }: {
    id: string;
    title: string;
    body: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    disabled?: boolean;
}) {
    return (
        <dialog id={id} className="modal">
            <div className="modal-box">
                <h3 className="font-bold text-lg">{title}</h3>
                <div className="py-4">{body}</div>
                <div className="modal-action">
                    <form method="dialog" className="flex gap-2">
                        <button className="btn btn-ghost">Cancel</button>
                        <button
                            className="btn btn-error"
                            disabled={disabled}
                            onClick={(e) => {
                                e.preventDefault();
                                onConfirm();
                                (document.getElementById(id) as HTMLDialogElement | null)?.close();
                            }}
                        >
                            {confirmLabel}
                        </button>
                    </form>
                </div>
            </div>
        </dialog>
    );
}

export default ConfirmModal;



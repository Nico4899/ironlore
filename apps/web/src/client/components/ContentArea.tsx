import { useAppStore } from "../stores/app.js";

export function ContentArea() {
  const activePath = useAppStore((s) => s.activePath);

  return (
    <main className="flex flex-1 flex-col overflow-hidden" style={{ minWidth: "480px" }}>
      {activePath ? (
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <p className="text-sm text-secondary">Editing: {activePath}</p>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Welcome to Ironlore</h1>
            <p className="mt-2 text-sm text-secondary">
              Select a page from the sidebar or create a new one.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

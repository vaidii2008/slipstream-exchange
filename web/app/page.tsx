import { SessionMenu } from "@/components/session-menu";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold tracking-tight">Slipstream</h1>
        <SessionMenu />
      </header>
    </div>
  );
}

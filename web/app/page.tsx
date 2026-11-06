import { ConnectionStatus } from "@/components/connection-status";
import { SessionMenu } from "@/components/session-menu";
import { Terminal } from "@/components/terminal";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-tight">Slipstream</h1>
          <ConnectionStatus />
        </div>
        <SessionMenu />
      </header>
      <Terminal />
    </div>
  );
}

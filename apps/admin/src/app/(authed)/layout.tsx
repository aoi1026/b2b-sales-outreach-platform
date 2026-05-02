import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <Header userName={user.name} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

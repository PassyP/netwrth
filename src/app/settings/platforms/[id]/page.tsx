import { PlatformDetail } from "@/components/settings/platform-detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // key: bij een ander platform begint de pagina met schone staat (open dialogen, sync-rapporten)
  return <PlatformDetail key={id} id={Number(id)} />;
}

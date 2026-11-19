import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Разбор резюме под вакансию",
  description:
    "Сравнение текста резюме с текстом вакансии: что уже закрыто, чего не хватает и три правки формулировок.",
};

function metrikaId(): string {
  const raw = process.env.NEXT_PUBLIC_YM_ID?.trim() ?? "";
  return /^\d+$/.test(raw) ? raw : "";
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  const ymId = metrikaId();

  return (
    <html lang="ru" className="h-full">
      <body className="flex min-h-full flex-col bg-stone-100 text-stone-900">
        {children}
        <footer className="border-t border-stone-200 px-4 py-6 text-center text-xs leading-relaxed text-stone-500">
          Прототип к отклику на вакансию{" "}
          <a
            className="underline decoration-stone-300 underline-offset-2 hover:text-stone-700"
            href="https://changellenge.com/vacancy/junior-ai-product-manager/"
          >
            Junior AI Product Manager в Changellenge
          </a>
        </footer>
        {ymId ? (
          <Script id="yandex-metrika" strategy="afterInteractive">
            {`(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
m[i].l=1*new Date();
for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
ym(${ymId}, "init", { clickmap:true, trackLinks:true, accurateTrackBounce:true });`}
          </Script>
        ) : null}
      </body>
    </html>
  );
}

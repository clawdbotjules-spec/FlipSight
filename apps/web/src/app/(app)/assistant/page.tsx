"use client";

/**
 * AI Listing Assistant: drop photos + a few words → Claude drafts an eBay
 * listing (≤80-char title, item specifics, honest description) priced from
 * the comp engine. Every field has a one-click copy button.
 */
import { Suspense, useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { usd } from "@/lib/format";
import type { ListingDraftResponse } from "@/lib/types";
import { CameraIcon, CopyIcon, SparkIcon, WarnIcon, XIcon } from "@/components/icons";

interface Photo {
  name: string;
  mediaType: string;
  data: string; // bare base64
  preview: string; // object URL
}

const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`btn btn-ghost px-2 py-0.5 text-[10px] ${copied ? "text-profit" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <CopyIcon width={11} height={11} /> {copied ? "copied" : label}
    </button>
  );
}

function AssistantInner() {
  const params = useSearchParams();
  const itemId = params.get("itemId");
  const [notes, setNotes] = useState(params.get("title") ?? "");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!ACCEPTED.includes(file.type)) continue;
      if (file.size > 5 * 1024 * 1024) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const data = (reader.result as string).split(",")[1] ?? "";
        setPhotos((prev) =>
          prev.length >= 4
            ? prev
            : [...prev, { name: file.name, mediaType: file.type, data, preview: URL.createObjectURL(file) }],
        );
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const draft = useMutation({
    mutationFn: () =>
      api<ListingDraftResponse>("/assistant/listing", {
        method: "POST",
        body: {
          notes,
          imagesBase64: photos.map((p) => ({ mediaType: p.mediaType, data: p.data })),
          ...(itemId ? { itemId } : {}),
        },
      }),
  });

  const result = draft.data;
  const unconfigured = draft.error instanceof ApiError && draft.error.status === 503;
  const canSubmit = notes.trim().length >= 3 && (photos.length > 0 || itemId) && !draft.isPending;

  return (
    <div className="mx-auto grid max-w-6xl items-start gap-5 lg:grid-cols-2">
      {/* Input side */}
      <section className="space-y-3">
        <div
          className={`glass grid min-h-44 cursor-pointer place-items-center p-6 text-center transition-colors ${
            dragOver ? "border-acc/60 bg-acc/5" : ""
          }`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <div>
            <CameraIcon width={28} height={28} className="mx-auto text-acc/70" />
            <p className="mt-2 text-sm text-muted">Drop photos here or click to choose</p>
            <p className="mt-1 text-[11px] text-faint">up to 4 · jpeg/png/webp/gif · ≤5MB each</p>
            {itemId && <p className="mt-2 text-[11px] text-acc2">+ photos from the selected item are included</p>}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED.join(",")}
            multiple
            hidden
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </div>

        {photos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={i} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.preview} alt={p.name} className="h-20 w-20 rounded-lg border border-line object-cover" />
                <button
                  className="absolute -top-1.5 -right-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-full border border-line bg-panel text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-loss"
                  onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove photo"
                >
                  <XIcon width={10} height={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div>
          <label className="label" htmlFor="notes">
            A few words about the item
          </label>
          <textarea
            id="notes"
            className="field min-h-24"
            placeholder="dewalt 20v drill, works great, comes with battery + charger, light scratches"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <button className="btn btn-acc w-full py-2.5" disabled={!canSubmit} onClick={() => draft.mutate()}>
          <SparkIcon width={15} height={15} />
          {draft.isPending ? "Drafting listing…" : "Draft my listing"}
        </button>

        {draft.isPending && (
          <div className="glass glass-flat space-y-2 p-4">
            {["reading photos", "identifying product", "writing title & specifics", "pricing from comps"].map((step, i) => (
              <p key={step} className="pulse-dot text-[11px] text-faint" style={{ animationDelay: `${i * 300}ms` }}>
                ⋯ {step}
              </p>
            ))}
          </div>
        )}

        {unconfigured && (
          <div className="glass glass-flat flex items-start gap-2.5 border-warn/30 p-3.5 text-[12px] text-warn">
            <WarnIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span>
              The listing assistant needs <span className="num">ANTHROPIC_API_KEY</span> on the API service — add it to
              .env and restart.
            </span>
          </div>
        )}
        {draft.isError && !unconfigured && (
          <p className="text-xs text-loss">{(draft.error as Error).message}</p>
        )}
      </section>

      {/* Output side */}
      <section>
        {!result && !draft.isPending && (
          <div className="glass glass-flat grid min-h-64 place-items-center p-6 text-center">
            <div>
              <SparkIcon width={24} height={24} className="mx-auto text-faint" />
              <p className="mt-2 text-sm text-faint">The generated listing lands here.</p>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="glass p-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="label mb-0">Title</span>
                <div className="flex items-center gap-2">
                  <span className={`num text-[10px] ${result.draft.titleLength > 80 ? "text-loss" : "text-faint"}`}>
                    {result.draft.titleLength}/80
                  </span>
                  <CopyButton text={result.draft.title} />
                </div>
              </div>
              <p className="text-[14px] font-medium">{result.draft.title}</p>
            </div>

            <div className="glass glass-flat p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="label mb-0">Suggested price</span>
                <span className="chip">{result.pricing.basis === "ebay_sold_comps" ? `from ${result.pricing.compsCount} sold comps` : "AI estimate"}</span>
              </div>
              <p className="num text-2xl font-semibold text-profit">{usd(result.pricing.suggested)}</p>
              <p className="num mt-0.5 text-[11px] text-faint">
                range {usd(result.pricing.low)} – {usd(result.pricing.high)}
              </p>
            </div>

            <div className="glass glass-flat p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="label mb-0">Item specifics</span>
                <CopyButton
                  text={result.draft.itemSpecifics.map((s) => `${s.name}: ${s.value}`).join("\n")}
                  label="copy all"
                />
              </div>
              <table className="w-full text-[12px]">
                <tbody className="divide-y divide-line">
                  {result.draft.itemSpecifics.map((s) => (
                    <tr key={s.name}>
                      <td className="py-1.5 pr-3 text-muted">{s.name}</td>
                      <td className="py-1.5 text-ink">{s.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="glass glass-flat p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="label mb-0">Description</span>
                <CopyButton text={result.draft.description} />
              </div>
              <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">{result.draft.description}</p>
            </div>

            <div className="glass glass-flat p-4">
              <span className="label">Category & keywords</span>
              <p className="text-[12px] text-ink">{result.draft.categorySuggestion}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="chip capitalize">{result.draft.condition.replaceAll("_", " ")}</span>
                {result.draft.keywords.map((k) => (
                  <span key={k} className="chip">
                    {k}
                  </span>
                ))}
              </div>
              <p className="num mt-2 text-[10px] text-faint">
                model {result.meta.model} · comps query “{result.meta.searchQuery}”
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function AssistantPage() {
  return (
    <Suspense>
      <AssistantInner />
    </Suspense>
  );
}

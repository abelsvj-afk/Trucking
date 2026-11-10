// The white-paper Page face for an app-created document (mockup
// UIUX-Mockup-DocumentViewer.html, locked): renders the STORED model
// only — firm/title header with gold rule, meta grid, route block,
// line table, totals, signature. Structure comes from
// lib/document-page's honest parsing; no field is invented.

import type { DocumentModel } from "@/lib/document-templates";
import { modelToPageSections } from "@/lib/document-page";

export default function DocumentPageFace({ model, kindLabel }: { model: DocumentModel; kindLabel?: string }) {
  const sections = modelToPageSections(model);
  return (
    <article className="doc-page" aria-label={model.title}>
      <div className="doc-firm">
        <div>
          <b className="doc-firm-name">Road to Legacy</b>
          <small>Created in the app from the records below</small>
        </div>
        <div className="doc-doctype">
          <b>{kindLabel ?? model.title}</b>
        </div>
      </div>
      <h2 className="doc-title">{model.title}</h2>
      {sections.map((section, si) => (
        <div key={si}>
          {section.heading && <h3 className="doc-section-heading">{section.heading}</h3>}
          {section.blocks.map((block, bi) => {
            if (block.kind === "meta") {
              return (
                <dl key={bi} className="doc-meta">
                  {block.items.map((item) => (
                    <div key={item.label}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              );
            }
            if (block.kind === "route") {
              return (
                <div key={bi} className="doc-route">
                  {block.lines.map((l) => (
                    <p key={l.label}><b>{l.label}:</b> {l.value}</p>
                  ))}
                </div>
              );
            }
            if (block.kind === "table") {
              return (
                <table key={bi} className="doc-table">
                  <thead><tr><th>Charge</th><th className="r">Amount</th></tr></thead>
                  <tbody>
                    {block.rows.map((row) => (
                      <tr key={row.label}><td>{row.label}</td><td className="r">{row.value}</td></tr>
                    ))}
                    {block.total && (
                      <tr className="total"><td>Total</td><td className="r">{block.total.value}</td></tr>
                    )}
                  </tbody>
                </table>
              );
            }
            if (block.kind === "signature") {
              return (
                <div key={bi} className="doc-sign">
                  <div className="doc-sign-line" />
                  <span>{block.text}</span>
                </div>
              );
            }
            return (
              <div key={bi}>
                {block.lines.map((line, li) => (
                  <p key={li} className="doc-line">{line}</p>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </article>
  );
}

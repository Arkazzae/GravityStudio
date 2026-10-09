"use client";

import { useState, type ReactNode } from "react";
import { Layers2, Search, X } from "lucide-react";
import type { Brand } from "@/lib/model-brand";
import { BrandMark } from "./BrandMark";
import { MenuLabel, MenuNote, MenuOption } from "./Dropdown";
import styles from "./ModelPickerList.module.css";

export interface ModelPickerRow {
  id: string;
  name: string;
  note: string;
  brand: Brand;
  badge?: ReactNode;
  disabled?: boolean;
}

/** Shared family order and search for generation models and Explore galleries. */
export function ModelPickerList({ rows, value, onSelect, all, empty }: {
  rows: ModelPickerRow[];
  value: string;
  onSelect: (id: string) => void;
  all?: boolean;
  empty?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const families = new Map<string, ModelPickerRow[]>();
  for (const row of rows) {
    const text = `${row.name} ${row.brand.family} ${row.note}`.toLocaleLowerCase();
    if (!terms.every(term => text.includes(term))) continue;
    const family = families.get(row.brand.family) ?? [];
    family.push(row);
    families.set(row.brand.family, family);
  }
  const matches = [...families.values()].reduce((total, family) => total + family.length, 0);
  function select(id: string) { setSearch(""); onSelect(id); }

  return <div onKeyDown={event => {
    // Let text fields keep their cursor keys; arrows also work between choices.
    const input = event.target instanceof HTMLInputElement;
    if (!(input ? ["ArrowDown", "ArrowUp"] : ["ArrowDown", "ArrowUp", "Home", "End"]).includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : current < 0 ? event.key === "ArrowUp" ? items.length - 1 : 0
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }}>
    <MenuLabel className={styles.heading}><span>Models by family</span><span>{matches}{terms.length ? ` / ${rows.length}` : ""}</span></MenuLabel>
    {rows.length > 8 || search ? <label className={styles.search}>
      <Search size={15} aria-hidden="true" />
      <input aria-label="Search models or families" placeholder="Search models or families…" value={search} onChange={event => setSearch(event.target.value)} />
      {search ? <button type="button" aria-label="Clear model search" onClick={() => setSearch("")}><X size={14} /></button> : null}
    </label> : null}
    <div className={styles.list} role="menu" aria-label="Models by family">
      {all ? <MenuOption label="All models" icon={<Layers2 />} active={!value} onClick={() => select("")}
        badge={<span className={styles.count}>{rows.length}</span>} /> : null}
      {[...families].map(([name, family]) => <div key={name} role="group" aria-label={name} className={styles.family}>
        <MenuLabel className={styles.familyHeading}>
          <BrandMark brand={{ ...family[0].brand, initial: name[0].toUpperCase() }} className="size-3.5" />
          <span>{name}</span><span className={styles.count}>{family.length}</span>
        </MenuLabel>
        {family.map(row => <MenuOption key={row.id} label={row.name} note={row.note} icon={<BrandMark brand={row.brand} />}
          badge={row.badge} active={value === row.id} disabled={row.disabled} onClick={() => select(row.id)} />)}
      </div>)}
    </div>
    {!matches ? <MenuNote>{terms.length ? `No model matches “${search.trim()}”.` : empty ?? "No models available."}</MenuNote> : null}
  </div>;
}

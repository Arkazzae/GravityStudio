'use client';
import { Layers2, SlidersHorizontal } from 'lucide-react';
import { BrandMark } from '@/components/ui/BrandMark';
import { Chip } from '@/components/ui/Chip';
import { ModelPickerList, type ModelPickerRow } from '@/components/ui/ModelPickerList';
import { Popover } from '@/components/ui/Popover';
import { modelBrand } from '@/lib/model-brand';
import type { StudioModel } from '@/lib/api';

export function ModelMenu({ models, value, onChange, referenceCount, onManage, disabled = false }: { models: StudioModel[]; value: string; onChange: (id: string) => void; referenceCount: number; onManage: () => void; disabled?: boolean }) {
  const selected = models.find(model => model.id === value);
  const rows: ModelPickerRow[] = models.map(model => {
    const maxImages = model.capabilities?.maxImages ?? model.limits?.maxImages ?? 0;
    const incompatible = referenceCount > maxImages;
    return {
      id: model.id,
      name: model.name,
      brand: modelBrand(model),
      disabled: disabled || !model.ready || incompatible,
      note: !model.ready ? model.unavailableReason || model.missingReasons?.[0] || 'Download this model from Models'
        : incompatible ? 'Remove reference images to use this model'
          : maxImages > 0 ? 'Text or image reference' : 'Text to image',
    };
  });

  return <Popover label="Choose a model" width={360} flush initialFocus='input, [role="menuitem"]:not(:disabled), [data-manage-models]'
    trigger={({ open, triggerProps }) => <Chip {...triggerProps} disabled={disabled} active={open} chevron="right" className="max-w-[184px] pr-2.5"
      aria-label={`Model: ${selected?.name || 'Choose a model'}`}
      icon={selected ? <BrandMark brand={modelBrand(selected)} className="size-[18px]" /> : <Layers2 />}>
      {selected?.name || 'Choose a model'}
    </Chip>}>
    {close => <>
      <ModelPickerList rows={rows} value={value} onSelect={id => { onChange(id); close(); }} empty="Download a model from Models to start creating." />
      <div className="mt-1 border-t border-line pt-1"><button type="button" data-manage-models aria-label="Manage image models" onClick={() => { close(); onManage(); }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-ink-2 hover:bg-white/[0.05] hover:text-ink"><SlidersHorizontal size={15} />Manage models</button></div>
    </>}
  </Popover>;
}

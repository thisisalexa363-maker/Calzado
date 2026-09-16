import { Plus, Trash2 } from "lucide-react";
import { Button, SelectInput, TextArea, TextInput } from "./ui";

export function emptyGuideShare() {
  return { numero_guia: "", cantidad: "", tienda_id: "", detalle: "" };
}

export function guideTotal(items) {
  return (items || []).reduce((total, item) => total + Number(item.cantidad || 0), 0);
}

export function GuideDistribution({ items, stores = [], onChange }) {
  const shares = items?.length ? items : [emptyGuideShare()];
  const total = guideTotal(shares);

  function update(index, changes) {
    onChange(shares.map((item, itemIndex) => (itemIndex === index ? { ...item, ...changes } : item)));
  }

  function remove(index) {
    const next = shares.filter((_, itemIndex) => itemIndex !== index);
    onChange(next.length ? next : [emptyGuideShare()]);
  }

  return (
    <div className="form-span brand-distribution">
      <div className="brand-distribution-header">
        <div>
          <strong>Guías revisadas</strong>
          <span>Agrega cada número de guía con la cantidad revisada.</span>
        </div>
        <Button variant="secondary" icon={Plus} onClick={() => onChange([...shares, emptyGuideShare()])}>
          Añadir guía
        </Button>
      </div>

      {shares.map((share, index) => (
        <div className="brand-share-row" key={index}>
          <TextInput
            label={`Número de guía ${index + 1}`}
            value={share.numero_guia}
            onChange={(numero_guia) => update(index, { numero_guia })}
            placeholder="Ej. GUIA-001"
          />
          <TextInput
            label="Cantidad"
            type="number"
            min="1"
            step="1"
            value={share.cantidad}
            onChange={(cantidad) => update(index, { cantidad })}
          />
          <SelectInput
            label="Tienda"
            value={share.tienda_id || ""}
            onChange={(tienda_id) => update(index, { tienda_id })}
            options={[
              { value: "", label: "Selecciona una tienda" },
              ...stores.map((store) => ({ value: String(store.id), label: store.nombre }))
            ]}
          />
          <div className="guide-share-detail">
            <TextArea
              label={`Detalle de la guía ${index + 1}`}
              value={share.detalle || ""}
              onChange={(detalle) => update(index, { detalle })}
              placeholder="Comentarios opcionales de esta guía"
              rows="2"
            />
          </div>
          <Button variant="ghost" icon={Trash2} onClick={() => remove(index)} disabled={shares.length === 1}>
            Quitar
          </Button>
        </div>
      ))}

      <div className={`brand-total ${total > 0 ? "complete" : "pending"}`}>
        Cantidad total: <strong>{total}</strong>
      </div>
    </div>
  );
}

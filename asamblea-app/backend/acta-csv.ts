export interface ActaVoteRow {
  id_voto: string;
  pregunta: string;
  unidad: string;
  propietario_documento: string;
  propietario_nombre: string;
  coeficiente_aportado: string;
  opcion_votada: string;
  registrado_en_utc: string;
}

function csvCell(value: string): string {
  const safe = /^[\u0000-\u0020]*[=+@-]/.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function serializeActaCsv(rows: ActaVoteRow[]): string {
  const header = ["Id de voto", "Pregunta", "Unidad", "Cédula/NIT del propietario", "Propietario", "Coeficiente aportado (%)", "Opción votada", "Marca de tiempo (UTC)"];
  const records = rows.map(row => [row.id_voto, row.pregunta, row.unidad, row.propietario_documento, row.propietario_nombre,
    row.coeficiente_aportado, row.opcion_votada, row.registrado_en_utc]);
  return "\uFEFF" + [header, ...records].map(record => record.map(value => csvCell(value ?? "")).join(",")).join("\r\n") + "\r\n";
}

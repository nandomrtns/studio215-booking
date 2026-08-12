/**
 * Validação de CPF — formato + dígito verificador (algoritmo mod-11 padrão).
 * Isso NÃO confirma que o CPF está ativo/existe na Receita Federal — é só uma
 * checagem offline de que o número é matematicamente válido. Validação de CPF
 * ativo de verdade fica pra depois, se algum dia for necessário.
 */

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function checkDigit(digits: string, weightStart: number): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[i]) * (weightStart - i);
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCpf(rawValue: string): boolean {
  const cpf = onlyDigits(rawValue);

  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais (000.000.000-00 etc.)

  const firstCheck = checkDigit(cpf.slice(0, 9), 10);
  if (firstCheck !== Number(cpf[9])) return false;

  const secondCheck = checkDigit(cpf.slice(0, 10), 11);
  if (secondCheck !== Number(cpf[10])) return false;

  return true;
}

/** Formata pra exibição/armazenamento consistente: 000.000.000-00. */
export function formatCpf(rawValue: string): string {
  const cpf = onlyDigits(rawValue);
  if (cpf.length !== 11) return rawValue;
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9, 11)}`;
}

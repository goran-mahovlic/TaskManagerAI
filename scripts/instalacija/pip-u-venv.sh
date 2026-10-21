# pip-u-venv.sh — izvori se (`. scripts/instalacija/pip-u-venv.sh`); bez izvršavanja.
#
# pip_u_venv VENV PAKET… — instalira pakete u venv napravljen s --without-pip.
# Prvo pip samog venva (ensurepip), jer pip sustava zna --python tek od inačice 22.3, a Python iz
# macOS Command Line Tools (3.9) nosi pip 21.2: „no such option: --python" (K8 krug 1, TASK-5662).
# Pip sustava s --python ostaje rezerva za Debian bez ensurepip-a (python3-venv nije instaliran).
pip_u_venv() {
  local venv="$1"; shift
  if "$venv/bin/python" -m pip --version >/dev/null 2>&1 || "$venv/bin/python" -m ensurepip >/dev/null 2>&1; then
    "$venv/bin/python" -m pip install -q --disable-pip-version-check "$@"
  else
    python3 -m pip --python "$venv/bin/python" install -q "$@"
  fi
}

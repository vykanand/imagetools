import sys, os
from rembg import remove, new_session
from PIL import Image

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python removebg.py <input> <output>', file=sys.stderr)
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2]

    if not os.path.exists(in_path):
        print(f'Input not found: {in_path}', file=sys.stderr)
        sys.exit(1)

    try:
        session = new_session('silueta')
        inp = Image.open(in_path)
        out = remove(inp, session=session, post_process_mask=True)
        out.save(out_path)
        d = list(out.getdata())
        opq = sum(1 for p in d if p[3] == 255)
        print(f'OK {out.size[0]}x{out.size[1]} opq={opq}')
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)

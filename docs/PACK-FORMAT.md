# How a clothing pack is put together

You do not need this to use ClothingStudio, but it explains *why* the app does what it does when you add, move or delete a
piece, and it helps when something in game does not look right.

## The folder

```
my_pack/                         <- the resource folder you open
  fxmanifest.lua
  mp_m_freemode_01_<dlc>.meta    <- shop metadata (SHOP_PED_APPAREL_META_FILE), male
  mp_f_freemode_01_<dlc>.meta    <- the same for female
  stream/
    mp_m_freemode_01_<dlc>.ymt   <- male  "how many textures does each piece have"
    mp_f_freemode_01_<dlc>.ymt   <- female
    mp_creaturemetadata_m_<dlc>.ymt   (only if a hat uses hair scale / shoes use heels)
    [male]/
      jbib/   mp_m_freemode_01_<dlc>^jbib_000_u.ydd
              mp_m_freemode_01_<dlc>^jbib_diff_000_a_uni.ytd
              mp_m_freemode_01_<dlc>^jbib_diff_000_b_uni.ytd
      p_head/ mp_m_freemode_01_p_<dlc>^p_head_000.ydd
              mp_m_freemode_01_p_<dlc>^p_head_diff_000_a.ytd
    [female]/ ...
```

`<dlc>` is the pack's name (for example `js_gsp`). The folders inside `stream/` are only for tidiness; the game goes by the file names.

## File names

| File | Pattern | Example |
|---|---|---|
| Clothing model | `mp_<m\|f>_freemode_01_<dlc>^<type>_<NNN>_<r\|u>.ydd` | `mp_m_freemode_01_gsp^jbib_003_u.ydd` |
| Clothing texture | `mp_<m\|f>_freemode_01_<dlc>^<type>_diff_<NNN>_<letter>_<whi\|uni>.ytd` | `…^jbib_diff_003_b_uni.ytd` |
| Prop model (hats, glasses …) | `mp_<m\|f>_freemode_01_p_<dlc>^<prop>_<NNN>.ydd` | `mp_m_freemode_01_p_gsp^p_head_000.ydd` |
| Prop texture | `mp_<m\|f>_freemode_01_p_<dlc>^<prop>_diff_<NNN>_<letter>.ytd` | `…^p_head_diff_000_b.ytd` |

- **`NNN`** is the piece's number inside its category, `000`, `001`, `002` … with **no gaps**. The game finds a piece by
  category + number, which is why ClothingStudio renumbers when you delete or move one.
- **`letter`** is the texture (`a`, `b` … up to `z`), the colour / style choices of that piece.
- **`r` / `whi`** = the piece shows **skin** underneath (pants, shoes, torsos); **`u` / `uni`** = it does not (tops, bags).
  That is what the **Shows skin** option switches. Props have neither.
- The name inside a `.ytd` does not have to match its file name; the app does not touch it.

### Categories

| Clothing `<type>` | Meaning | | Prop `<prop>` | Meaning |
|---|---|---|---|---|
| `head` | Heads | | `p_head` | Hats |
| `berd` | Masks | | `p_eyes` | Glasses |
| `hair` | Hair | | `p_ears` | Ear items |
| `uppr` | Torsos / arms | | `p_mouth` | Mouth |
| `lowr` | Pants | | `p_lhand` / `p_rhand` | Left / right hand |
| `hand` | Bags / badges | | `p_lwrist` / `p_rwrist` | Wrists |
| `feet` | Shoes | | `p_hip` | Hip |
| `teef` | Accessories | | `p_lfoot` / `p_rfoot` | Feet |
| `accs` | Undershirts | | `p_ph_l_hand` / `p_ph_r_hand` | Phone (left / right) |
| `task` | Armor / vests | | | |
| `decl` | Decals | | | |
| `jbib` | Tops | | | |

## The `.ymt` (ped variation)

`mp_m_freemode_01_<dlc>.ymt` is the game's index of your pack. For each category (component slot or prop slot) it lists the
pieces **by position** and, for each piece, **how many textures it has**, plus audio, flags (and for props: render flag, anchor).
A piece is only in the game if it is listed, and a piece's textures only show if the count is right.

That is why a texture file you add by hand is invisible in game until the `.ymt` says so. ClothingStudio does it for you whenever it
changes files, and the top-bar chip shows when something is out of step.

Because pieces are stored by position, the numbers must run `000, 001, 002 …` without gaps. Deleting `001` of three would
otherwise leave a hole the file cannot express. That is why deleting renumbers.

ClothingStudio reads and writes the file in the same layout CodeWalker and grzyClothTool use (details in
[TECHNICAL.md](TECHNICAL.md)). The first change makes `<name>.ymt.bak`.

## Creature metadata (hair scale and high heels)

Two settings do not live in the ped `.ymt` alone, they need an *expression* attached through a second file,
`mp_creaturemetadata_<m|f>_<dlc>.ymt`:

- **Hair scale** (hats): squashes the hair under a hat. The value is stored on the hat in the ped `.ymt`; the creature file says
  "hats have this expression". As grzyClothTool does: if **any** hat uses hair scale, **every** hat gets an entry (plus one dummy
  first entry that every original game file has).
- **High heels** (shoes): lifts the character. If **any** pair of shoes uses heels, **every** pair of shoes gets an entry.

With neither in use, there is no creature file at all. ClothingStudio creates, updates and removes it for you, including when you add,
move or delete pieces.

## The `.meta` files

A pack ships `.meta` files next to `fxmanifest.lua` (normally `mp_m_freemode_01_<dlc>.meta` and `mp_f_freemode_01_<dlc>.meta`,
loaded by the manifest as `SHOP_PED_APPAREL_META_FILE`). ClothingStudio does **not** edit them, except that **Build** and **New**
write standard ones for a new resource. Some packs add other `.meta` files that list pieces **by number**, such as
`first_person_alternates_*.meta` and `pedalternativevariations_*.meta`. After moving or deleting pieces the app tells you if your
pack has them so you can check the numbers by hand.

## Textures

A `.ytd` is a texture dictionary. Clothing uses three pixel formats:

| Format | Notes |
|---|---|
| **DXT1** | Compressed, no or on / off transparency. Smallest |
| **DXT5** | Compressed with smooth transparency |
| **A8R8G8B8** | Uncompressed, lossless, big |

ClothingStudio writes a texture back in its **original size and format** and regenerates the mip levels. DXT formats are lossy, so
very smooth photo-like gradients can show slight banding; logos, flat colours and text look great. If you want maximum quality for a
texture, use A8R8G8B8.

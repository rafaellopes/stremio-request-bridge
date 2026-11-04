#!/bin/sh
# Regenerates the short MP4 notices that players show when an action entry is selected.
# Needs ffmpeg with drawtext (libfreetype). Avoid , : ' % in the texts (drawtext escaping).
set -e
cd "$(dirname "$0")/.."

FONT="${FONT:-/System/Library/Fonts/Helvetica.ttc}"
[ -f "$FONT" ] || FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

make() { # locale name line1 line2
  mkdir -p "assets/notices/$1"
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=0x14161c:s=1280x720:d=4:r=24" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -vf "drawtext=fontfile=$FONT:text='$3':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h/2-60,drawtext=fontfile=$FONT:text='$4':fontcolor=0x9aa3b2:fontsize=32:x=(w-text_w)/2:y=h/2+20" \
    -t 4 -c:v libx264 -pix_fmt yuv420p -preset veryslow -crf 28 -c:a aac -b:a 32k -movflags +faststart -shortest \
    "assets/notices/$1/$2.mp4"
}

make en ok   "Request sent"                "It will download in the background"
make en wait "Already requested"            "Download in progress"
make en err  "Could not send the request"   "Check the addon logs or try again later"

make pt ok   "Pedido enviado"               "Vai descarregar em segundo plano"
make pt wait "Pedido ja feito"              "Download em curso"
make pt err  "Nao foi possivel pedir"       "Ve os logs do addon ou tenta mais tarde"

ls -la assets/notices/*/

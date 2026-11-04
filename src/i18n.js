// Strings shown inside the Stremio stream list. Stremio truncates long lines, so keep the first words informative.
const messages = {
  en: {
    action: '⬇ Download',
    movieDetail: 'Select to send this movie to your media server. It downloads in the background, so the TV can do something else.',
    seasonDetail: (n) => `Select to request the whole of season ${n}. It downloads in the background, so the TV can do something else.`,
    requested: '⏳ Requested',
    requestedMovie: 'Request sent, looking for a release. This can take a few minutes.',
    requestedSeason: (n) => `Request sent, looking for season ${n}. This can take a few minutes.`,
    downloading: (pct) => `⏳ Downloading ${pct}%`,
    downloadingMovie: (pct) => `Downloading to your media server: ${pct}% done.`,
    downloadingSeason: (n, pct) => `Season ${n}: ${pct}% done.`,
    doneHint: 'When it finishes it will show up in your media server addon.',
  },
  pt: {
    action: '⬇ Descarregar',
    movieDetail: 'Carrega aqui para descarregar este filme para o servidor. O download corre em segundo plano, a TV pode ficar a fazer outra coisa.',
    seasonDetail: (n) => `Carrega aqui para descarregar a temporada ${n} inteira. O download corre em segundo plano, a TV pode ficar a fazer outra coisa.`,
    requested: '⏳ Pedido feito',
    requestedMovie: 'Pedido enviado, a procurar uma versão. Pode demorar uns minutos.',
    requestedSeason: (n) => `Pedido enviado, a procurar a temporada ${n}. Pode demorar uns minutos.`,
    downloading: (pct) => `⏳ A descarregar ${pct}%`,
    downloadingMovie: (pct) => `A descarregar para o servidor: ${pct}% concluído.`,
    downloadingSeason: (n, pct) => `Temporada ${n}: ${pct}% concluído.`,
    doneHint: 'Quando acabar, aparece no addon do teu servidor de media.',
  },
};

export const strings = (locale) => messages[locale] || messages.en;

/**
 * Tipos compartilhados entre o backend (/api/meetly) e as telas do Meetly.
 *
 * O formato segue o app Android original (vigneshshettyin/Meetly): uma reunião
 * tem título, descrição, data, horário, uma sala de vídeo (Jitsi), uma cor e a
 * lista de participantes — o primeiro participante é o anfitrião.
 */

export interface MeetlyUser {
  id: string;
  email: string;
  displayName: string;
  phone: string;
  /** Data URL da foto enviada pelo usuário, ou "" para usar as iniciais. */
  imageUrl: string;
  createdAt: number;
}

export interface MeetlyParticipant {
  id: string;
  email: string;
  displayName: string;
  imageUrl: string;
  isHost: boolean;
}

export interface MeetlyMeetingSummary {
  id: string;
  title: string;
  content: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm (24 h) */
  time: string;
  color: string;
  room: string;
  hostId: string;
  hostName: string;
  isHost: boolean;
  attendeeCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MeetlyMeetingDetail extends MeetlyMeetingSummary {
  participants: MeetlyParticipant[];
  /** Endereço completo da sala de vídeo, ex.: https://meet.jit.si/<sala> */
  joinUrl: string;
  jitsiDomain: string;
}

export interface MeetlyMeetingInput {
  title: string;
  content: string;
  date: string;
  time: string;
}

export interface MeetlyProfileInput {
  displayName: string;
  phone: string;
  imageUrl: string;
}

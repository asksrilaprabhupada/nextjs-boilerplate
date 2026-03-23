export interface SlideImage {
  url: string;
  alt: string;
  kenBurnsDirection: "zoom-in" | "pan-left" | "pan-right";
}

export const KEN_BURNS_DIRECTIONS: SlideImage["kenBurnsDirection"][] = [
  "zoom-in",
  "pan-left",
  "pan-right",
];

/**
 * Fallback image used if no usable lock screen photos are discovered.
 */
export const lockscreenFallbackImage: SlideImage = {
  url: "/images/lockscreen/Prabh14.jpg",
  alt: "Śrīla Prabhupāda",
  kenBurnsDirection: "zoom-in",
};

/**
 * Optional video background for the lock screen.
 * Admin: upload an mp4 to public/videos/lockscreen/ and set the path here.
 * Set to null to use the photo slideshow instead.
 */
export const lockscreenVideo: string | null = null;

export interface DailyVerse {
  text: string;
  citation: string;
}

export const dailyVerses: DailyVerse[] = [
  {
    text: "For one who has conquered the mind, the mind is the best of friends; but for one who has failed to do so, his mind will remain the greatest enemy.",
    citation: "Bhagavad Gītā 6.6",
  },
  {
    text: "The humble sages, by virtue of true knowledge, see with equal vision a learned and gentle brāhmaṇa, a cow, an elephant, a dog and a dog-eater.",
    citation: "Bhagavad Gītā 5.18",
  },
  {
    text: "Whatever action a great man performs, common men follow. And whatever standards he sets by exemplary acts, all the world pursues.",
    citation: "Bhagavad Gītā 3.21",
  },
  {
    text: "One who is not disturbed in mind even amidst the threefold miseries or elated when there is happiness, and who is free from attachment, fear and anger, is called a sage of steady mind.",
    citation: "Bhagavad Gītā 2.56",
  },
  {
    text: "For the soul there is neither birth nor death at any time. He has not come into being, does not come into being, and will not come into being.",
    citation: "Bhagavad Gītā 2.20",
  },
  {
    text: "The Supreme Personality of Godhead said: It is lust only, Arjuna, which is born of contact with the material mode of passion and later transformed into wrath, and which is the all-devouring sinful enemy of this world.",
    citation: "Bhagavad Gītā 3.37",
  },
  {
    text: "A person in the divine consciousness, although engaged in seeing, hearing, touching, smelling, eating, moving about, sleeping and breathing, always knows within himself that he actually does nothing at all.",
    citation: "Bhagavad Gītā 5.8-9",
  },
  {
    text: "In this endeavor there is no loss or diminution, and a little advancement on this path can protect one from the most dangerous type of fear.",
    citation: "Bhagavad Gītā 2.40",
  },
  {
    text: "One who sees the Supersoul accompanying the individual soul in all bodies, and who understands that neither the soul nor the Supersoul within the destructible body is ever destroyed, actually sees.",
    citation: "Bhagavad Gītā 13.28",
  },
  {
    text: "He who is without attachment, who does not rejoice when he obtains good, nor lament when he obtains evil, is firmly fixed in perfect knowledge.",
    citation: "Bhagavad Gītā 2.57",
  },
  {
    text: "To those who are constantly devoted to serving Me with love, I give the understanding by which they can come to Me.",
    citation: "Bhagavad Gītā 10.10",
  },
  {
    text: "Abandon all varieties of religion and just surrender unto Me. I shall deliver you from all sinful reactions. Do not fear.",
    citation: "Bhagavad Gītā 18.66",
  },
];

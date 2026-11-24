import inquirer from 'inquirer';
import { chooseLinesToVerify } from '../src/cli/commands/env';

jest.mock('inquirer', () => ({ __esModule: true, default: { prompt: jest.fn() } }));
const prompt = inquirer.prompt as unknown as jest.Mock;

const choices = [
  { lineId: 'a', title: 'A', lastStationId: 'S2', nextStationId: 'S1', allGreen: false },
  { lineId: 'b', title: 'B', allGreen: false, unreadable: 'Line not installed: b' },
];

beforeEach(() => prompt.mockReset());

describe('verify line chooser', () => {
  it('returns the selected lines and disables unreadable ones', async () => {
    prompt.mockResolvedValue({ lineIds: ['a'] });

    await expect(chooseLinesToVerify(choices)).resolves.toEqual(['a']);

    const question = prompt.mock.calls[0][0][0];
    expect(question.type).toBe('checkbox');
    expect(question.choices.map((c: { value: string; disabled: unknown }) => [c.value, c.disabled])).toEqual([
      ['a', false],
      ['b', 'unreadable'],
    ]);
  });

  it('treats Ctrl+C as "no lines" instead of crashing verify', async () => {
    const abort = Object.assign(new Error('User force closed the prompt with SIGINT'), {
      name: 'ExitPromptError',
    });
    prompt.mockRejectedValue(abort);

    await expect(chooseLinesToVerify(choices)).resolves.toEqual([]);
  });

  it('still surfaces unexpected prompt errors', async () => {
    prompt.mockRejectedValue(new Error('boom'));

    await expect(chooseLinesToVerify(choices)).rejects.toThrow('boom');
  });
});
